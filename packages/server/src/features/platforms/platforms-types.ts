import type {
  DraftSnapshot,
  PlatformCapability,
  PlatformChapterInput,
  PlatformId,
  PlatformProvider,
  PlatformReadiness,
  PlatformWork,
  PlatformWorkInput,
} from '../../../../../shared/platforms.js';
import { platformCapabilities } from '../../../../../shared/platforms.js';

export interface PlatformCredential {
  token: string;
}
export interface VerifiedAccount {
  accountId: string;
  accountName: string;
}
export interface PlatformAdapter {
  provider: PlatformProvider;
  connect(credential: PlatformCredential): Promise<VerifiedAccount>;
  listWorks(credential: PlatformCredential, connectionId: string): Promise<PlatformWork[]>;
  createWork?(
    credential: PlatformCredential,
    input: PlatformWorkInput,
    connectionId: string,
  ): Promise<PlatformWork>;
  updateWork?(
    credential: PlatformCredential,
    work: PlatformWork,
    input: Partial<PlatformWorkInput>,
  ): Promise<PlatformWork>;
  syncWork?(credential: PlatformCredential, work: PlatformWork): Promise<PlatformWork>;
}
export interface VerifiedDraft extends PlatformChapterInput {
  id: string;
  workId: string;
  accountId: string;
  paragraphs: string[];
  volumeId?: string;
  publishStatus?: number;
}
export interface FanqieVolume {
  id: string;
  name: string;
  itemCount?: number;
}
export interface FanqieChapter {
  id: string;
  title: string;
  volumeId?: string;
  status: number;
  kind: 'draft' | 'chapter';
}
/** Sensitive browser state is an in-memory value, never a filename or an API response. */
export interface BrowserSessionState {
  cookies: unknown[];
  origins: unknown[];
}
export interface DraftBrowserAdapter {
  readonly readiness: PlatformReadiness;
  readonly reason: string;
  startLogin(loginId: string): Promise<void>;
  loginOpen(loginId: string): boolean;
  completeLogin(loginId: string): Promise<{ account: VerifiedAccount; state: BrowserSessionState }>;
  closeLogin(loginId: string): Promise<void>;
  verifyAccount(connectionId: string, state: BrowserSessionState): Promise<VerifiedAccount>;
  /** Capture an existing context only; no navigation, login, or remote refresh request. */
  sessionState?(connectionId: string): Promise<BrowserSessionState | undefined>;
  listWorks(connectionId: string, state: BrowserSessionState): Promise<PlatformWork[]>;
  listVolumes?(connectionId: string, state: BrowserSessionState, workId: string): Promise<FanqieVolume[]>;
  listChapters?(connectionId: string, state: BrowserSessionState, workId: string, volumeId?: string): Promise<FanqieChapter[]>;
  /** Caller must checkpoint the remote mutation before invoking this method. Never delete/recreate. */
  overwriteDraft?(
    connectionId: string, state: BrowserSessionState, accountId: string, workId: string,
    draftId: string, snapshot: DraftSnapshot, volumeId?: string,
  ): Promise<VerifiedDraft>;
  /** Called only AFTER the runtime durably records mutationStarted and user approval. */
  createDraft(
    connectionId: string,
    state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
    onIdentified: (draftId: string) => void,
    volumeId?: string,
  ): Promise<{ draftId: string }>;
  /** Must reopen the exact known draft (not trust the editor just filled). Never mutate. */
  readDraft(
    connectionId: string,
    state: BrowserSessionState,
    workId: string,
    draftId: string,
  ): Promise<VerifiedDraft>;
  /** Read-only search: zero or multiple matches remain unknown and never permit blind resend. */
  findDrafts(
    connectionId: string,
    state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
  ): Promise<VerifiedDraft[]>;
  /** Delete only an exact, previously identified draft; implementation must verify disappearance. */
  deleteDraft(
    connectionId: string,
    state: BrowserSessionState,
    workId: string,
    draftId: string,
  ): Promise<void>;
  /** Submit only a known, read-back verified draft. Resolve only after read-only review receipt. */
  submitReview?(
    connectionId: string, state: BrowserSessionState, accountId: string,
    workId: string, draftId: string, snapshot: DraftSnapshot, useAi?: 1 | 2,
  ): Promise<void>;
  /** Read-only reconciliation of a known submission; never publish or reopen the editor. */
  verifyReviewReceipt?(
    connectionId: string, state: BrowserSessionState, accountId: string,
    workId: string, draftId: string, snapshot: DraftSnapshot,
  ): Promise<boolean>;
  closeConnection(connectionId: string): Promise<void>;
  close(): Promise<void>;
}
export class PlatformError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public capability?: PlatformCapability,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}
export function unsupported(provider: PlatformProvider, capability: PlatformCapability): never {
  throw new PlatformError(
    501,
    'PLATFORM_CAPABILITY_UNSUPPORTED',
    `${provider.name} 尚未开放已核验的 ${capability} 能力。${provider.readinessReason || provider.description}`,
    capability,
  );
}
export function provider(
  id: PlatformId,
  name: string,
  available: boolean,
  description: string,
  enabled: Partial<Record<PlatformCapability, boolean>> = {},
  readiness: PlatformReadiness = 'unavailable',
): PlatformProvider {
  return {
    id,
    name,
    available,
    description,
    readiness,
    authMethods: [],
    capabilities: Object.fromEntries(
      platformCapabilities.map((capability) => [capability, enabled[capability] === true]),
    ) as Record<PlatformCapability, boolean>,
  };
}
