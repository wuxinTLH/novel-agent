import express from 'express';
import type { FeatureService, ServiceContext } from './context.js';
import { installHttpFallbacks, installHttpPolicy } from './http.js';
import { coreServices, registerServices } from './registry.js';

export interface ApplicationOptions {
  port: number;
  appRoot: string;
  /** Optional features register after all core routes, before the API 404/error handlers. */
  services?: readonly FeatureService[];
}

/** Creates the guarded application without listening or installing process signal handlers. */
export function createApplication(context: ServiceContext, options: ApplicationOptions) {
  const app = express();
  installHttpPolicy(app, context, options.port);
  registerServices(app, context, [...coreServices, ...(options.services || [])]);
  installHttpFallbacks(app, options.appRoot);
  return app;
}
