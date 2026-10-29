import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createApplication } from '../application.js';
import { createServiceContext, type ServiceContext } from '../context.js';
import { activateScopedStorage } from '../../infrastructure/storage/storage-config.js';
import { createWorkerPlatformAccountLockClient, installPlatformAccountLockClient, type PlatformAccountLockCredentials } from './platform-account-lock.js';

interface RuntimeData {
  root: string;
  dir: string;
  ownerId?: string;
  port: number;
  trustedAliasPorts?: readonly number[];
  appRoot: string;
  inheritEnvironment: boolean;
  capability: string;
  platformAccountLocks: PlatformAccountLockCredentials;
}

/** Private entry point only. Never import the server index or install process signal hooks. */
async function run(data: RuntimeData) {
  let context: ServiceContext | undefined;
  let binding: ReturnType<typeof activateScopedStorage> | undefined;
  let server: http.Server | undefined;
  let closing: Promise<void> | undefined;
  let finishStartup!: () => void;
  const startup = new Promise<void>((resolve) => {
    finishStartup = resolve;
  });
  const close = () =>
    (closing ??= (async () => {
      await startup;
      const drained = new Promise<void>((resolve, reject) => {
        if (!server?.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      try {
        if (context) {
          for (const controller of context.runner.controllers.values()) controller.abort();
          await context.platformRuntime.close();
          while (context.runner.controllers.size) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await drained;
      } finally {
        binding?.unbind();
        const storage = binding?.storage;
        if (storage && 'close' in storage && typeof storage.close === 'function') await storage.close();
      }
    })());
  parentPort!.on('message', (message: { type?: string }) => {
    if (message.type === 'close')
      void close().then(
        () => {
          parentPort!.postMessage({ type: 'closed' });
          parentPort!.close();
        },
        () => {
          parentPort!.postMessage({ type: 'failed' });
          parentPort!.close();
          process.exitCode = 1;
        },
      );
  });
  try {
    // Validate the original path chain before mkdir; rejecting only the leaf permits users/ symlink escape.
    const relative = path.relative(path.resolve(data.root), path.resolve(data.dir));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UNSAFE_TENANT_DIRECTORY');
    let cursor = path.resolve(data.root);
    fs.mkdirSync(cursor, { recursive: true, mode: 0o700 });
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_TENANT_DIRECTORY');
    }
    binding = activateScopedStorage(data.root, data.dir, data.ownerId);
    installPlatformAccountLockClient(createWorkerPlatformAccountLockClient(parentPort!, data.platformAccountLocks));
    context = createServiceContext(data.dir, data.inheritEnvironment);
    const app = createApplication(context, {
      port: data.port,
      trustedAliasPorts: data.trustedAliasPorts,
      appRoot: data.appRoot,
      assertStorageHealthy: () => binding?.storage?.assertHealthy(),
    });
    server = http.createServer((req, res) => {
      const peer = req.socket.remoteAddress;
      const supplied = req.headers['x-novel-runtime-capability'];
      const expected = Buffer.from(data.capability);
      const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '') ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      delete req.headers['x-novel-runtime-capability'];
      app(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    server.on('error', () => {
      parentPort!.postMessage({ type: 'failed' });
      void close().finally(() => {
        parentPort!.close();
        process.exitCode = 1;
      });
    });
    finishStartup();
    if (closing) {
      await closing;
      return;
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('RUNTIME_LISTENER_UNAVAILABLE');
    parentPort!.postMessage({ type: 'ready', port: address.port, csrfToken: context.platformRuntime.csrfToken });
  } catch {
    finishStartup();
    parentPort!.postMessage({ type: 'failed' });
    try {
      await close();
    } catch {
      /* sanitized failure already reported */
    }
    parentPort!.close();
    process.exitCode = 1;
  }
}

if (!isMainThread && parentPort) void run(workerData as RuntimeData);
