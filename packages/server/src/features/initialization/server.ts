import fs from 'node:fs';
import { acquireDataLock } from '../../core/local-runtime.js';
import { configureHttpServer } from '../../core/security-profile.js';
import { logger } from '../../core/logger.js';
import { createInitializationApplication } from './application.js';
import { validateInitTokenEnvironment } from './state.js';
import type { WebHostingOptions } from '../../core/web-hosting.js';

export function startInitializationServer(options: { dir: string; port: number; bindHost: string } & WebHostingOptions) {
  validateInitTokenEnvironment(process.env);
  const release = acquireDataLock(options.dir);
  process.once('exit', release);
  try {
    fs.chmodSync(options.dir, 0o700);
    // Application repeats the fresh-directory check while holding the application instance lock.
    const runtime = createInitializationApplication({ ...options, env: process.env });
    const server = runtime.app.listen(options.port, options.bindHost, () => {
      logger.info('Server Init 已隔离启动。仅通过可信 HTTPS 或受控宿主回环映射/隧道访问 /init；此入口不提供 TLS。', 'SERVICE_STARTED');
      if (runtime.tokenFile) logger.info('初始化令牌文件：' + runtime.tokenFile, 'SERVICE_STARTED');
      if (process.connected && process.send) process.send({ type: 'novel-agent:ready' }, () => {});
    });
    configureHttpServer(server);
    let closing = false;
    const close = () => {
      if (closing) return; closing = true;
      if (process.connected && process.send) process.send({ type: 'novel-agent:stopping' }, () => {});
      server.close(() => { release(); process.exit(0); });
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 20_000).unref();
    };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    if (process.send) {
      process.once('disconnect', close);
      process.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'type' in message && 'signal' in message &&
          message.type === 'novel-agent:shutdown' && (message.signal === 'SIGINT' || message.signal === 'SIGTERM')) close();
      });
    }
    server.on('error', () => { logger.error('初始化监听失败。', 'SERVICE_LISTEN_FAILED'); release(); process.exit(1); });
    return server;
  } catch (error) { release(); throw error; }
}
