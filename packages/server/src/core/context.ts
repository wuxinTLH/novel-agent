import type { Express } from 'express';
import { Store } from '../features/projects/store.js';
import { Runner } from '../features/generation/engine.js';
import { PlatformRuntime } from '../features/platforms/platform-runtime.js';
import { completeWorkflowPublication } from '../features/workflow/workflow-publication.js';
import { createModelProvider, type ModelProvider } from '../features/models/model-provider.js';

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

export function createServiceContext(dir: string, inheritEnvironment = true): ServiceContext {
  const store = new Store(dir);
  const platformRuntime = new PlatformRuntime(store);
  const runner = new Runner(store, (project, run, workflow) =>
    completeWorkflowPublication(store, platformRuntime, project, run, workflow),
  );
  return { dir, store, platformRuntime, runner, modelProvider: createModelProvider(dir, inheritEnvironment) };
}
