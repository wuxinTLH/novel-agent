import type {
  DraftSnapshot,
  PlatformCapability,
  PlatformChapterInput,
  PlatformId,
  PlatformProvider,
  PlatformReadiness,
  PlatformWork,
  PlatformWorkInput,
} from '../shared/platforms.js';
import { platformCapabilities } from '../shared/platforms.js';

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
  listWorks(connectionId: string, state: BrowserSessionState): Promise<PlatformWork[]>;
  /** Called only AFTER the runtime durably records mutationStarted and user approval. */
  createDraft(
    connectionId: string,
    state: BrowserSessionState,
    accountId: string,
    workId: string,
    snapshot: DraftSnapshot,
    onIdentified: (draftId: string) => void,
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
    `${provider.name} 尚未开放已核验的 ${capability} 能力。`,
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
