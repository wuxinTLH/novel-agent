import path from 'node:path';
import { acquireDataLock, appRoot } from './local-runtime.js';
import { createApplication } from './models/application.js';
import { createServiceContext, type FeatureService } from './models/context.js';
import { UserService } from './models/user.js';
import { SQLConnectService, createSQLconnectRouter } from './models/sqlconnect.js';
try {
  process.loadEnvFile(path.join(appRoot, '.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const port = Number(process.env.PORT || 3001);
const dir = path.resolve(appRoot, process.env.DATA_DIR || 'data');
const releaseDataLock = acquireDataLock(dir);
process.once('exit', releaseDataLock);
const context = createServiceContext(dir);
const { runner, platformRuntime } = context;
const users = new UserService(dir); // Intentionally dormant: no authentication provider is installed.
const sqlconnect = new SQLConnectService({ dataDir: dir, appRoot });
const services: FeatureService[] = [
  { id: 'User', register(app) { app.get('/api/services/user', users.statusHandler); } },
  { id: 'SQLconnect', register(app) { app.use('/api/sqlconnect', createSQLconnectRouter(sqlconnect)); }, close: () => sqlconnect.close() },
];
const app = createApplication(context, { port, appRoot, services });
const server = app.listen(port, '0.0.0.0', () => console.log(`Novel Agent API: http://0.0.0.0:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const controller of runner.controllers.values()) controller.abort();
  server.close();
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await Promise.all(services.map((service) => service.close?.()));
    await platformRuntime.close();
    while (runner.controllers.size) await new Promise((resolve) => setTimeout(resolve, 25));
    releaseDataLock();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    console.error('关闭未完整完成，下次启动请检查任务和数据目录锁。');
    process.exit(1);
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
server.on('error', () => {
  console.error('本机服务无法启动，请检查端口是否被占用。');
  void shutdown();
});
