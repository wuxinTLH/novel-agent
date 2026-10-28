import type { Express } from 'express';
import type { FeatureService, ServiceContext } from './context.js';
import { platformService } from '../features/platforms/platform.js';
import { modelSettingsService } from '../features/models/model-settings.js';
import { projectsService } from '../features/projects/projects.js';
import { workflowService } from '../features/workflow/workflow.js';
import { assetsService } from '../features/assets/assets.js';
import { generationService } from '../features/generation/routes/generation.js';
import { chaptersService } from '../features/chapters/chapters.js';
import { documentsService } from '../features/documents/documents.js';

/** Platform routes precede the general project mutation guard, as in the original API. */
export const coreServices: readonly FeatureService[] = [
  platformService,
  modelSettingsService,
  projectsService,
  workflowService,
  assetsService,
  generationService,
  chaptersService,
  documentsService,
];

export function registerServices(app: Express, context: ServiceContext, services: readonly FeatureService[]) {
  const seen = new Set<string>();
  for (const service of services) {
    if (seen.has(service.id)) throw new Error(`Duplicate backend service: ${service.id}`);
    seen.add(service.id);
  }
  for (const service of services) service.register(app, context);
}
