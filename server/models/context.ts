import type { Express } from 'express';
import { Store } from '../store.js';
import { Runner } from '../engine.js';
import { PlatformRuntime } from '../platform-runtime.js';
import { completeWorkflowPublication } from '../workflow-publication.js';
import { createModelProvider, type ModelProvider } from './model-provider.js';

/** Shared local runtime dependencies; optional features do not replace the existing Store. */
export interface ServiceContext {
  dir: string;
  store: Store;
  platformRuntime: PlatformRuntime;
  runner: Runner;
  modelProvider: ModelProvider;
}

/** Each feature owns its handlers and registers them against the shared guarded app. */
export interface FeatureService {
  id: string;
  register(app: Express, context: ServiceContext): void;
  close?(): Promise<void>;
}

export function createServiceContext(dir: string): ServiceContext {
  const store = new Store(dir);
  const platformRuntime = new PlatformRuntime(store);
  const runner = new Runner(store, (project, run, workflow) =>
    completeWorkflowPublication(store, platformRuntime, project, run, workflow),
  );
  return { dir, store, platformRuntime, runner, modelProvider: createModelProvider(dir) };
}
