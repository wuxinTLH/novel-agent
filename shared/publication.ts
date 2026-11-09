import type { DraftSnapshot, PlatformId } from './platforms.js';

/** Serializable, credential-free identity approved by the user. */
export interface PublicationTarget {
  projectId: string;
  connectionId: string;
  providerId: PlatformId;
  accountId: string;
  accountName: string;
  linkId: string;
  remoteWorkId: string;
  workTitle: string;
  workRevision: string;
}
export type PublicationAction = 'save_draft' | 'submit_review';
/** Read-only resolved remote intent, included in the immutable approval hash. */
export type PublicationChapterRemotePlan = {
  chapterId: string;
  volumeId: string;
  volumeName: string;
  predecessor?: { source: 'publication' | 'draft'; operationId: string };
} & (
  | { mode: 'create' }
  | { mode: 'reuse' | 'overwrite'; remoteDraftId: string; expectedRemoteFingerprint: string }
);
export interface PublicationPreview {
  id: string;
  target: PublicationTarget;
  action: PublicationAction;
  /** Explicit per-prepare opt-in. Absent only on legacy immutable previews. */
  autoApprove?: boolean;
  /** Required for review: 1 = AI used, 2 = no AI used. No implicit default. */
  useAi?: 1 | 2;
  chapters: DraftSnapshot[];
  /** Absent only on legacy previews; never synthesize targets into approved history. */
  remotePlan?: PublicationChapterRemotePlan[];
  createdAt: string;
  hash: string;
}
export interface PublicationItem {
  id: string;
  snapshot: DraftSnapshot;
  state: 'queued' | 'running' | 'draft_verified' | 'submitted' | 'failed' | 'unknown' | 'cancelled';
  mutationStarted: boolean;
  remoteDraftId?: string;
  remoteFingerprint?: string;
  error?: string;
  reconciliation?: { checkedAt: string; outcome: 'draft_verified' | 'submitted' | 'unproven' };
}
/** Only these credential-free diagnostic identifiers may be persisted from hook failures. */
export const publicationFailureCodes = [
  'PLATFORM_BUSY', 'PLATFORM_LOCK_UNAVAILABLE', 'PLATFORM_REAUTH_REQUIRED', 'PLATFORM_LOGIN_CLOSED',
  'PLATFORM_ACCOUNT_MISMATCH', 'PLATFORM_DOM_VERIFICATION_REQUIRED', 'PLATFORM_PAGE_LOAD_FAILED',
  'PLATFORM_DOM_MISMATCH', 'PLATFORM_WORK_NOT_FOUND', 'PLATFORM_BINDING_CHANGED', 'PLATFORM_PREVIEW_CHANGED',
  'PUBLICATION_REMOTE_CHANGED', 'PROJECT_RUNNING', 'PLATFORM_ORPHAN_UNKNOWN',
  // Explicit queue invariants reachable during validation/execution; never accept arbitrary queue codes.
  'DUPLICATE_CHAPTER', 'CONFLICTING_VERSION', 'INVALID_STATE', 'MUTATION_NOT_CHECKPOINTED',
  'REMOTE_ID_CHANGED', 'INVALID_OUTCOME', 'INVALID_PREVIEW', 'SNAPSHOT_CHANGED',
] as const;
export type PublicationFailureCode = typeof publicationFailureCodes[number];
export type PublicationFailureStage = 'acquire' | 'validate' | 'execute';
/** Local diagnostic metadata only: no chapter content, credentials or remote requests. */
export interface PublicationDeletionBlockers {
  removable: boolean;
  /** Explicit local deletion may retain all platform evidence, including unknown outcomes. */
  canDeletePreservingRecords?: boolean;
  busy: boolean;
  batches: {
    id: string;
    state: PublicationBatch['state'];
    /** Exact immutable preview hash required by the cancellation request. */
    approvalHash: string;
    canCancel: boolean;
    errorCode?: PublicationFailureCode;
    failureStage?: PublicationFailureStage;
    items: { number: number; state: PublicationItem['state']; mutationStarted: boolean; hasRemoteDraftId: boolean }[];
  }[];
  legacyOperations: { id: string; state: string }[];
}
export interface PublicationBatch {
  id: string;
  preview: PublicationPreview;
  state: 'preview' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  /** Local-only cancellation, allowed only when no item could have mutated remotely. */
  cancelledAt?: string;
  items: PublicationItem[];
  approvalHash?: string;
  approval?: { mode: 'manual' | 'automatic'; source: 'prepare' | 'start'; approvedAt: string; hash: string };
  startRequestIds: string[];
  pauseRequested: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Exact allowlisted identifier only, never the original hook message or payload. */
  errorCode?: PublicationFailureCode;
  failureStage?: PublicationFailureStage;
}
