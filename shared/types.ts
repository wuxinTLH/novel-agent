export const categories = ['world', 'characters', 'plot', 'chapters'] as const;
export type Category = (typeof categories)[number];
export const categoryLabels: Record<Category, string> = {
  world: '世界与地图',
  characters: '人物设定',
  plot: '剧情走向',
  chapters: '章节设定',
};
export const stepIds = ['lore', 'outline', 'plan', 'draft', 'review'] as const;
export type BuiltinStepId = (typeof stepIds)[number];
export const SYSTEM_START_NODE_ID = 'system-start';
export const SYSTEM_END_NODE_ID = 'system-end';
export const SYSTEM_NODE_IDS = [SYSTEM_START_NODE_ID, SYSTEM_END_NODE_ID] as const;
/** Workflow ids are extensible; system boundary ids are reserved by the application. */
export type StepId = string;
export type Status = 'idle' | 'running' | 'done' | 'error';
export interface Asset {
  id: string;
  name: string;
  category: Category;
  content: string;
  url?: string;
  mime?: string;
  size: number;
  createdAt: string;
}
export interface Step {
  id: StepId;
  title: string;
  subtitle: string;
  prompt: string;
  status: Status;
  output: string;
  position: { x: number; y: number };
  kind?:
    | 'agent'
    | 'start'
    | 'end'
    | 'audit'
    | 'writer'
    | 'custom'
    | 'world'
    | 'outline'
    | 'plan'
    | 'expand'
    | 'character'
    | 'dialogue'
    | 'scene'
    | 'continuity';
  /** Optional saved result name. Empty means derive one from the generated content. */
  outputName?: string;
  modelId?: string;
  assetIds?: string[];
  enabled?: boolean;
  /** Identifies the target/snapshot that produced output; old unscoped output is never reused. */
  generationContext?: StepGenerationContext;
}
export interface Requirements {
  instructions: string;
  requiredText: string[];
  forbiddenText: string[];
}
export type GenerationTarget =
  | { kind: 'next'; count?: number }
  | { kind: 'single'; number: number }
  | { kind: 'range'; from: number; to: number };
export type GenerationMode = 'create' | 'regenerate';
export interface RunRequest {
  workflowId?: string;
  stepId?: StepId;
  target?: GenerationTarget;
  mode?: GenerationMode;
  outputWriterNodeId?: string;
  /** Optional world-setting name used when this workflow saves setting assets. */
  outputName?: string;
}
export interface StepGenerationContext {
  runId: string;
  workflowId: string;
  number: number;
  mode: GenerationMode;
  requirements: Requirements;
  chapterId?: string;
  baseRevision?: number;
  graphRevision: number;
  outputWriterNodeId?: string;
  /** Optional name for a world-setting workflow result. Empty derives from content. */
  outputName?: string;
}
export interface WorkflowEdge {
  id: string;
  source: StepId;
  target: StepId;
  label?: string;
}
export interface WorkflowSettings {
  id?: string;
  name?: string;
  edges: WorkflowEdge[];
  startNodeId?: StepId;
  endNodeId?: StepId;
  auditNodeId?: StepId;
  chapterCount: number;
  autoGenerate: boolean;
  /** Legacy only. Always disabled; generation never writes to a platform. */
  autoPublish?: boolean;
  graphRevision?: number;
  outputWriterNodeId?: string;
  /** Optional name for a world-setting workflow result. Empty derives from content. */
  outputName?: string;
}
export interface WorkflowGraph {
  id: string;
  name: string;
  steps: Step[];
  workflow: WorkflowSettings;
  createdAt: string;
  updatedAt: string;
}
export interface ChapterRevision {
  revision: number;
  title: string;
  content: string;
  updatedAt: string;
  mode: 'demo' | 'live';
}
export interface Chapter {
  id: string;
  number: number;
  revision: number;
  title: string;
  content: string;
  updatedAt: string;
  mode: 'demo' | 'live';
  workflowId?: string;
  runId?: string;
  outputWriterNodeId?: string;
  requirements?: Requirements;
  revisions?: ChapterRevision[];
  /** Archived legacy simulation marker; never evidence of real publication. */
  legacyPublishedAt?: string;
}
export interface ChapterCandidate {
  id: string;
  number: number;
  title: string;
  content: string;
  chapterId?: string;
  baseRevision?: number;
  issues: string[];
  createdAt: string;
  mode: 'demo' | 'live';
  generationMode: GenerationMode;
  workflowId: string;
  runId: string;
  outputWriterNodeId: string;
  requirements: Requirements;
  reviewOutput?: string;
  recoveryStatus?: 'pending-review' | 'review-failed' | 'ready';
  graphRevision?: number;
  errorCode?: string;
  error?: string;
  /** Semantic review remains advisory even when literal checks pass. */
  semanticStatus: 'pending-author';
}
export interface RunChapterProgress {
  number: number;
  status: 'pending' | 'running' | 'done' | 'candidate' | 'error' | 'cancelled';
  validationStatus: 'pending' | 'passed' | 'failed';
  reviewStatus: 'pending' | 'done' | 'not-configured';
  requirements: Requirements;
  chapterId?: string;
  baseRevision?: number;
  candidateId?: string;
  issues: string[];
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}
export interface Run {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stepId?: StepId;
  mode: 'demo' | 'live';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  admissionKey?: string;
  requestHash?: string;
  workflowId?: string;
  request?: RunRequest;
  generationMode?: GenerationMode;
  outputWriterNodeId?: string;
  targets?: number[];
  currentChapter?: number;
  chapters?: RunChapterProgress[];
  generatedChapterIds?: string[];
  candidateIds?: string[];
  semanticStatus?: 'pending-author';
}
export interface Project {
  id: string;
  title: string;
  genre: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  assets: Asset[];
  steps: Step[];
  chapters: Chapter[];
  run?: Run;
  /** Recent completed admission metadata only; durable prose lives in candidates/chapters. */
  runHistory?: Run[];
  /** Durable admission tombstones; unlike runHistory these are never silently truncated. */
  runAdmissions?: Record<string, { requestHash: string; runId: string }>;
  workflow?: WorkflowSettings;
  workflows?: WorkflowGraph[];
  activeWorkflowId?: string;
  requirements?: Requirements;
  chapterRequirements?: Record<string, Requirements>;
  chapterNumberHighWatermark?: number;
  candidates?: ChapterCandidate[];
  dataVersion?: number;
}
export const modelProtocols = ['responses', 'chat-completions', 'anthropic-messages'] as const;
export type ModelProtocol = (typeof modelProtocols)[number];
export const protocolLabels: Record<ModelProtocol, string> = {
  responses: 'Responses API',
  'chat-completions': 'Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
};
export interface ModelProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  protocol: ModelProtocol;
  hasKey: boolean;
  enabled: boolean;
  createdAt: string;
}
export interface ModelSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  mode: 'demo' | 'live';
  protocol?: ModelProtocol;
  activeModelId?: string;
  models?: ModelProfile[];
}
