import type { Express } from 'express';
import type { FeatureService, ServiceContext } from './context.js';
import { platformService } from './platform.js';
import { modelSettingsService } from './model-settings.js';
import { projectsService } from './projects.js';
import { workflowService } from './workflow.js';
import { assetsService } from './assets.js';
import { generationService } from './generation.js';
import { chaptersService } from './chapters.js';

/** Platform routes precede the general project mutation guard, as in the original API. */
export const coreServices: readonly FeatureService[] = [
  platformService,
  modelSettingsService,
  projectsService,
  workflowService,
  assetsService,
  generationService,
  chaptersService,
];

export function registerServices(app: Express, context: ServiceContext, services: readonly FeatureService[]) {
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.id)) throw new Error(`Duplicate backend service: ${service.id}`);
    seen.add(service.id);
  }
  for (const service of services) service.register(app, context);
}
