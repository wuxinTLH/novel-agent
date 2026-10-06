export const platformIds = ['qidian', 'qimao', 'tomato', 'mock'] as const;
export type PlatformId = (typeof platformIds)[number];
export const platformCapabilities = [
  'connectToken',
  'oauth',
  'manualLogin',
  'extensionPairing',
  'listWorks',
  'getWork',
  'createWork',
  'updateWork',
  'syncWork',
  'saveDraft',
  'readDraft',
  'publishChapter',
] as const;
export type PlatformCapability = (typeof platformCapabilities)[number];
export type PlatformReadiness = 'ready' | 'needs_verification' | 'unavailable' | 'mock';
export interface PlatformProvider {
  id: PlatformId;
  name: string;
  available: boolean;
  description: string;
  authMethods: ('api_token' | 'oauth' | 'manual_browser' | 'browser_extension')[];
  capabilities: Record<PlatformCapability, boolean>;
  readiness: PlatformReadiness;
  readinessReason?: string;
}
export interface PlatformConnection {
  id: string;
  projectId: string;
  providerId: PlatformId;
  accountId: string;
  accountName: string;
  status: 'paired' | 'connected' | 'needs_reauth' | 'needs_verification';
  hasCredential: boolean;
  capabilities: {
    paired: boolean;
    accountVerified: boolean;
    listWorks: boolean;
    saveDraft: boolean;
  };
  createdAt: string;
  lastCheckedAt?: string;
}
export type ExtensionPairingStatus = 'waiting' | 'claimed' | 'confirmed' | 'closed' | 'expired';
export interface ExtensionPairing {
  id: string;
  projectId: string;
  providerId: 'tomato';
  status: ExtensionPairingStatus;
  challenge: string;
  createdAt: string;
  expiresAt: string;
  extensionOrigin?: string;
  tabId?: number;
  sessionId?: string;
  message: string;
}
export interface PlatformWork {
  id: string;
  providerId: PlatformId;
  title: string;
  description: string;
  genre: string;
  revision: string;
  chapterCount: number;
  updatedAt: string;
}
export interface ProjectPlatformWorkLink {
  id: string;
  projectId: string;
  connectionId: string;
  providerId: PlatformId;
  accountId: string;
  remoteWorkId: string;
  title: string;
  revision: string;
  lastSyncedAt: string;
}
export interface PlatformWorkInput {
  title: string;
  description: string;
  genre: string;
}
/** Historical local mock publication archive only. Never a real remote receipt. */
export interface PlatformChapter {
  id: string;
  workId: string;
  title: string;
  content: string;
  publishedAt: string;
}
export interface PlatformChapterInput {
  title: string;
  content: string;
}
export interface PlatformSession {
  csrfToken: string;
  persistentCredentials: boolean;
  available: boolean;
  reason?: string;
  legacyArchived: boolean;
  browser: { readiness: PlatformReadiness; reason: string; manualLogin: boolean };
}
export interface PlatformLogin {
  id: string;
  projectId: string;
  connectionId?: string;
  status: 'waiting' | 'needs_verification' | 'completed' | 'closed';
  message: string;
  createdAt: string;
  expiresAt: string;
}
export interface DraftSnapshot {
  chapterId: string;
  number: number;
  revision: number;
  title: string;
  content: string;
  paragraphs: string[];
  contentHash: string;
}
export interface DraftPreparation {
  id: string;
  projectId: string;
  connectionId: string;
  providerId: PlatformId;
  accountId: string;
  accountName: string;
  linkId: string;
  remoteWorkId: string;
  workTitle: string;
  snapshot: DraftSnapshot;
  createdAt: string;
  expiresAt: string;
  warning: string;
}
export type DraftOperationState = 'queued' | 'running' | 'verified' | 'failed' | 'unknown';
export interface DraftOperation {
  id: string;
  projectId: string;
  connectionId: string;
  providerId: PlatformId;
  accountId: string;
  remoteWorkId: string;
  chapterId: string;
  chapterNumber: number;
  revision: number;
  contentHash: string;
  title: string;
  state: DraftOperationState;
  mutationStarted: boolean;
  remoteDraftId?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  error?: string;
  errorCode?: string;
}
export interface DraftReceipt {
  id: string;
  operationId: string;
  projectId: string;
  connectionId: string;
  providerId: PlatformId;
  accountId: string;
  remoteWorkId: string;
  remoteDraftId: string;
  chapterId: string;
  revision: number;
  contentHash: string;
  title: string;
  verifiedAt: string;
}
export interface PlatformChapterChoice {
  id: string;
  number: number;
  revision: number;
  title: string;
  updatedAt: string;
  contentHash: string;
}
