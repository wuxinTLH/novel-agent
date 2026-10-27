import { createPlatformRouter } from '../platform-routes.js';
import type { FeatureService } from './context.js';
export const platformService: FeatureService = {
  id: 'platform',
  register(app, { store, platformRuntime }) {
    app.use('/api', createPlatformRouter(store, platformRuntime));
    app.get('/api/health', (_req, res) => res.json({ ok: true, platform: platformRuntime.status() }));
  },
};
