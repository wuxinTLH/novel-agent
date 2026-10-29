import express from 'express';
import { createExtensionBridgeRouter } from '../features/platforms/extension-bridge.js';
import type { FeatureService, ServiceContext } from './context.js';
import { installHttpFallbacks, installHttpPolicy } from './http.js';
import { coreServices, registerServices } from './registry.js';

export interface ApplicationOptions {
  port: number;
  trustedAliasPorts?: readonly number[];
  assertStorageHealthy?: () => void;
  appRoot: string;
  /** Optional features register after all core routes, before the API 404/error handlers. */
  services?: readonly FeatureService[];
}

/** Creates the guarded application without listening or installing process signal handlers. */
export function createApplication(context: ServiceContext, options: ApplicationOptions) {
  const app = express();
  // This router has its own strict extension origin, fixed Host and scoped bearer checks.
  // Never delegate ordinary business APIs through this exception.
  app.use('/api/platform-extension', createExtensionBridgeRouter(context.platformRuntime, options.port));
  installHttpPolicy(app, context, options.port, options.trustedAliasPorts);
  if (options.assertStorageHealthy)
    app.use('/api', (_req, _res, next) => {
      try {
        options.assertStorageHealthy!();
        next();
      } catch (error) {
        next(error);
      }
    });
  registerServices(app, context, [...coreServices, ...(options.services || [])]);
  installHttpFallbacks(app, options.appRoot);
  return app;
}
