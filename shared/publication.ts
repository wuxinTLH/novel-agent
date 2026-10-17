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
  state: 'queued' | 'running' | 'draft_verified' | 'submitted' | 'failed' | 'unknown';
  mutationStarted: boolean;
  remoteDraftId?: string;
  remoteFingerprint?: string;
  error?: string;
  reconciliation?: { checkedAt: string; outcome: 'draft_verified' | 'submitted' | 'unproven' };
}
export interface PublicationBatch {
  id: string;
  preview: PublicationPreview;
  state: 'preview' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown';
  items: PublicationItem[];
  approvalHash?: string;
  approval?: { mode: 'manual' | 'automatic'; source: 'prepare' | 'start'; approvedAt: string; hash: string };
  startRequestIds: string[];
  pauseRequested: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
