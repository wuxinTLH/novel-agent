import fs from 'node:fs';
import path from 'node:path';
import { documentStorage, readDocumentFile } from '../../infrastructure/storage/document-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DraftSnapshot } from '../../../../../shared/platforms.js';
import type { PublicationAction, PublicationBatch, PublicationItem, PublicationPreview, PublicationTarget, PublicationChapterRemotePlan } from '../../../../../shared/publication.js';
export type { PublicationAction, PublicationBatch, PublicationItem, PublicationPreview, PublicationTarget, PublicationChapterRemotePlan } from '../../../../../shared/publication.js';

export interface PublicationExecutionContext {
  /** MUST complete successfully BEFORE any browser mutation, including autosave. */
  beforeMutation(): void;
  /** Persist exact remote identity as soon as it becomes known. */
  identified(remoteDraftId: string): void;
}
export interface PublicationQueueHooks {
  /** Read-only. Compare every approved target/chapter field with current local AND remote state. */
  validate(preview: PublicationPreview, items?: readonly PublicationItem[]): Promise<void>;
  execute(preview: PublicationPreview, item: PublicationItem, context: PublicationExecutionContext): Promise<{
    state: 'draft_verified' | 'submitted';
    remoteDraftId?: string;
    remoteFingerprint?: string;
  }>;
  /** Read-only exact-ID evidence; undefined never changes an unknown outcome. */
  reconcile?(preview: PublicationPreview, item: PublicationItem): Promise<{ state: 'draft_verified' | 'submitted'; remoteDraftId: string; remoteFingerprint: string } | undefined>;
  /** Optional runtime account/worker lock, held across validation and the entire batch. */
  acquire?(preview: PublicationPreview): Promise<() => void | Promise<void>>;
}
export interface PublicationQueueOptions {
  /** Test seam. Must atomically replace the destination or throw without modifying it. */
  persist?: (filePath: string, contents: string) => void;
  now?: () => string;
}
export class PublicationQueueError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PublicationQueueError'; }
}
function reject(code: string, message: string): never { throw new PublicationQueueError(code, message); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function publicationPreviewHash(preview: Omit<PublicationPreview, 'hash'>): string {
  return createHash('sha256').update(canonical(preview)).digest('hex');
}
function atomicPersist(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) reject('INVALID_PREVIEW', `${label} is required`);
  return value;
}
function targetSnapshot(input: PublicationTarget): PublicationTarget {
  // Explicit allowlist: caller objects may contain session/credential properties; never retain them.
  return {
    projectId: text(input.projectId, 'projectId'), connectionId: text(input.connectionId, 'connectionId'),
    providerId: text(input.providerId, 'providerId') as PublicationTarget['providerId'],
    accountId: text(input.accountId, 'accountId'), accountName: text(input.accountName, 'accountName'),
    linkId: text(input.linkId, 'linkId'), remoteWorkId: text(input.remoteWorkId, 'remoteWorkId'),
    workTitle: text(input.workTitle, 'workTitle'), workRevision: text(input.workRevision, 'workRevision'),
  };
}
function chapterSnapshot(input: DraftSnapshot): DraftSnapshot {
  if (!Number.isSafeInteger(input.number) || input.number < 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
    typeof input.content !== 'string' || !input.content.trim() || !Array.isArray(input.paragraphs) || input.paragraphs.some(p => typeof p !== 'string'))
    reject('INVALID_PREVIEW', 'Invalid chapter snapshot');
  return {
    chapterId: text(input.chapterId, 'chapterId'), number: input.number, revision: input.revision,
    title: text(input.title, 'title'), content: input.content, paragraphs: [...input.paragraphs],
    contentHash: text(input.contentHash, 'contentHash'),
  };
}
function remotePlanSnapshot(input: PublicationChapterRemotePlan): PublicationChapterRemotePlan {
  if (!input || !['create', 'reuse', 'overwrite'].includes(input.mode)) reject('INVALID_PREVIEW', 'Invalid remote chapter mode');
  const common = {
    chapterId: text(input.chapterId, 'remote chapterId'),
    volumeId: text(input.volumeId, 'volumeId'), volumeName: text(input.volumeName, 'volumeName'),
    ...(input.predecessor ? { predecessor: {
      source: input.predecessor.source,
      operationId: text(input.predecessor.operationId, 'predecessor operationId'),
    } } : {}),
  };
  if (input.predecessor && !['publication', 'draft'].includes(input.predecessor.source)) reject('INVALID_PREVIEW', 'Invalid predecessor source');
  if (input.mode === 'create') {
    if (input.predecessor || 'remoteDraftId' in input || 'expectedRemoteFingerprint' in input) reject('INVALID_PREVIEW', 'Create must not reuse a remote identity');
    return { ...common, mode: 'create' };
  }
  return { ...common, mode: input.mode, remoteDraftId: text(input.remoteDraftId, 'remoteDraftId'),
    expectedRemoteFingerprint: text(input.expectedRemoteFingerprint, 'expectedRemoteFingerprint') };
}
function validateRemotePlan(preview: PublicationPreview): void {
  if (preview.remotePlan === undefined) return;
  if (!Array.isArray(preview.remotePlan) || preview.remotePlan.length !== preview.chapters.length)
    reject('INVALID_PREVIEW', 'Remote plan must match every chapter');
  const remoteIds = new Set<string>();
  preview.remotePlan.forEach((plan, index) => {
    if (canonical(remotePlanSnapshot(plan)) !== canonical(plan) || plan.chapterId !== preview.chapters[index].chapterId)
      reject('INVALID_PREVIEW', 'Remote plan does not match approved chapters');
    if (plan.mode !== 'create') {
      if (remoteIds.has(plan.remoteDraftId)) reject('DUPLICATE_CHAPTER', 'Remote chapter appears more than once');
      remoteIds.add(plan.remoteDraftId);
    }
  });
}
function planFor(preview: PublicationPreview, chapterId: string): PublicationChapterRemotePlan | undefined {
  return preview.remotePlan?.find(plan => plan.chapterId === chapterId);
}
function identity(preview: PublicationPreview, chapter: DraftSnapshot): string {
  return JSON.stringify([preview.target.providerId, preview.target.accountId, preview.target.remoteWorkId, chapter.chapterId]);
}

/** Local-only durable approval store. No timers, retries, browser or credentials. One writer per file. */
export class PublicationQueue {
  private batches: PublicationBatch[] = [];
  private tasks = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  private persist: (filePath: string, contents: string) => void;
  private now: () => string;
  constructor(private filePath: string, private hooks: PublicationQueueHooks, options: PublicationQueueOptions = {}) {
    this.persist = options.persist ?? ((file, contents) => {
      const backend = documentStorage(path.dirname(file));
      if (backend) backend.write(path.basename(file), contents);
      else atomicPersist(file, contents);
    });
    this.now = options.now ?? (() => new Date().toISOString());
    const source = readDocumentFile(filePath);
    if (source !== null) {
      const data = JSON.parse(source) as { version: number; batches: PublicationBatch[] };
      if (data.version !== 1 || !Array.isArray(data.batches)) reject('INVALID_STORE', 'Unsupported publication queue store');
      this.batches = data.batches;
      for (const batch of this.batches) this.checkBatch(batch);
      if (this.batches.some(b => b.state === 'running' || b.state === 'queued')) this.change(() => {
        for (const batch of this.batches) if (batch.state === 'running' || batch.state === 'queued') {
          for (const item of batch.items) if (item.state === 'running') {
            item.state = item.mutationStarted ? 'unknown' : 'queued';
            if (item.mutationStarted) item.error = 'Interrupted after mutation intent; reconcile manually, never retry blindly.';
          }
          batch.state = batch.items.some(i => i.state === 'unknown') ? 'unknown' : 'paused';
          batch.pauseRequested = true;
          batch.updatedAt = this.now();
        }
      });
    }
  }
  private change<T>(work: () => T): T {
    const old = clone(this.batches);
    try {
      const result = work();
      this.persist(this.filePath, JSON.stringify({ version: 1, batches: this.batches }, null, 2));
      return result;
    } catch (error) { this.batches = old; throw error; }
  }
  private batch(id: string): PublicationBatch {
    return this.batches.find(b => b.id === id) ?? reject('NOT_FOUND', 'Publication batch not found');
  }
  private checkHash(preview: PublicationPreview): void {
    const { hash, ...payload } = preview;
    if (hash !== publicationPreviewHash(payload)) reject('SNAPSHOT_CHANGED', 'Approved preview snapshot changed');
  }
  private checkBatch(batch: PublicationBatch): void {
    if (!batch || !batch.preview || !Array.isArray(batch.items) || !Array.isArray(batch.startRequestIds) ||
      batch.startRequestIds.some(id => typeof id !== 'string' || !id) || new Set(batch.startRequestIds).size !== batch.startRequestIds.length ||
      !['preview', 'queued', 'running', 'paused', 'completed', 'failed', 'unknown'].includes(batch.state) ||
      typeof batch.pauseRequested !== 'boolean' || !Array.isArray(batch.preview.chapters) ||
      !batch.preview.chapters.length || batch.preview.chapters.length > 50 || batch.id !== batch.preview.id ||
      !['save_draft', 'submit_review'].includes(batch.preview.action) ||
      (batch.preview.action === 'submit_review' && batch.preview.useAi !== 1 && batch.preview.useAi !== 2) ||
      (batch.preview.action === 'save_draft' && batch.preview.useAi !== undefined) ||
      (batch.approvalHash !== undefined && batch.approvalHash !== batch.preview.hash) ||
      (batch.state !== 'preview' && !batch.approvalHash) ||
      !Number.isFinite(Date.parse(batch.preview.createdAt))) reject('INVALID_STORE', 'Invalid publication queue record');
    if ((batch.preview.autoApprove !== undefined && typeof batch.preview.autoApprove !== 'boolean') ||
      (batch.approval !== undefined && (!['manual', 'automatic'].includes(batch.approval.mode) || !['prepare', 'start'].includes(batch.approval.source) ||
        batch.approval.hash !== batch.approvalHash || !Number.isFinite(Date.parse(batch.approval.approvedAt))))) reject('INVALID_STORE', 'Invalid publication approval provenance');
    if (canonical(targetSnapshot(batch.preview.target)) !== canonical(batch.preview.target)) reject('INVALID_STORE', 'Invalid publication target');
    for (const chapter of batch.preview.chapters) if (canonical(chapterSnapshot(chapter)) !== canonical(chapter)) reject('INVALID_STORE', 'Invalid chapter snapshot');
    validateRemotePlan(batch.preview);
    this.checkHash(batch.preview);
    const keys = batch.preview.chapters.map(chapter => identity(batch.preview, chapter));
    if (new Set(keys).size !== keys.length || new Set(batch.items.map(item => item.id)).size !== batch.items.length ||
      batch.items.some(item => !item.id || typeof item.mutationStarted !== 'boolean' ||
        !['queued', 'running', 'draft_verified', 'submitted', 'failed', 'unknown'].includes(item.state) ||
        (item.remoteFingerprint !== undefined && (typeof item.remoteFingerprint !== 'string' || !item.remoteFingerprint)) ||
        (item.remoteDraftId !== undefined && (typeof item.remoteDraftId !== 'string' || !item.remoteDraftId)))) reject('INVALID_STORE', 'Invalid publication items');
    if (batch.items.length !== batch.preview.chapters.length || batch.items.some((item, index) =>
      canonical(item.snapshot) !== canonical(batch.preview.chapters[index])))
      reject('SNAPSHOT_CHANGED', 'Execution item does not match approved preview');
  }
  findVerifiedDraft(preview: PublicationPreview, snapshot: DraftSnapshot): PublicationItem | undefined {
    const superseded = new Set(this.batches.flatMap(batch => batch.items.flatMap(item => {
      if (!batch.approvalHash || !['draft_verified', 'submitted'].includes(item.state)) return [];
      const predecessor = planFor(batch.preview, item.snapshot.chapterId)?.predecessor;
      return predecessor?.source === 'publication' ? [predecessor.operationId] : [];
    })));
    for (const batch of [...this.batches].reverse()) {
      if (!batch.approvalHash || batch.id === preview.id) continue;
      const item = batch.items.find(i => !superseded.has(i.id) && identity(batch.preview, i.snapshot) === identity(preview, snapshot) &&
        !(i.state === 'failed' && !i.mutationStarted));
      if (!item) continue;
      if (batch.preview.action === 'save_draft' && item.state === 'draft_verified' && item.remoteDraftId && canonical(item.snapshot) === canonical(snapshot))
        return freeze(clone(item));
      return undefined;
    }
    return undefined;
  }
  get(id: string): PublicationBatch { return freeze(clone(this.batch(id))); }
  list(projectId?: string): PublicationBatch[] {
    return freeze(clone(this.batches.filter(b => !projectId || b.preview.target.projectId === projectId)));
  }
  async preview(input: { target: PublicationTarget; action: PublicationAction; chapters: DraftSnapshot[]; useAi?: 1 | 2; remotePlan?: PublicationChapterRemotePlan[]; autoApprove?: boolean }): Promise<PublicationBatch> {
    if (input.autoApprove !== undefined && typeof input.autoApprove !== 'boolean') reject('INVALID_PREVIEW', 'autoApprove must be boolean');
    if (input.action === 'submit_review' && input.useAi !== 1 && input.useAi !== 2)
      reject('INVALID_PREVIEW', 'Review requires explicit AI declaration');
    if (input.action === 'save_draft' && input.useAi !== undefined)
      reject('INVALID_PREVIEW', 'AI declaration only applies to review');
    if (!['save_draft', 'submit_review'].includes(input.action) || !Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > 50)
      reject('INVALID_PREVIEW', 'Select between 1 and 50 chapters and a supported action');
    const payload = { id: randomUUID(), target: targetSnapshot(input.target), action: input.action, autoApprove: input.autoApprove ?? false,
      ...(input.useAi !== undefined ? { useAi: input.useAi } : {}),
      ...(input.remotePlan !== undefined ? { remotePlan: input.remotePlan.map(remotePlanSnapshot) } : {}),
      chapters: input.chapters.map(chapterSnapshot), createdAt: this.now() };
    const preview = { ...payload, hash: publicationPreviewHash(payload) };
    validateRemotePlan(preview);
    const keys = preview.chapters.map(c => identity(preview, c));
    if (new Set(keys).size !== keys.length) reject('DUPLICATE_CHAPTER', 'Chapter appears more than once');
    const release = await this.hooks.acquire?.(freeze(clone(preview)));
    try { await this.hooks.validate(freeze(clone(preview))); }
    finally { await release?.(); }
    const batch: PublicationBatch = { id: preview.id, preview, state: 'preview',
      items: preview.chapters.map(snapshot => ({ id: randomUUID(), snapshot: clone(snapshot), state: 'queued', mutationStarted: false })),
      startRequestIds: [], pauseRequested: false, createdAt: preview.createdAt, updatedAt: preview.createdAt };
    this.change(() => this.batches.push(batch));
    return this.get(batch.id);
  }
  private checkConflicts(batch: PublicationBatch): void {
    for (const item of batch.items) {
      if (item.state !== 'queued') continue;
      const plan = planFor(batch.preview, item.snapshot.chapterId);
      const overlaps: { batch: PublicationBatch; item: PublicationItem }[] = [];
      for (const other of this.batches) {
        if (other.id === batch.id || !other.approvalHash) continue;
        const sameWork = other.preview.target.providerId === batch.preview.target.providerId &&
          other.preview.target.accountId === batch.preview.target.accountId && other.preview.target.remoteWorkId === batch.preview.target.remoteWorkId;
        if (!sameWork) continue;
        for (const existing of other.items) {
          const existingPlan = planFor(other.preview, existing.snapshot.chapterId);
          const remoteId = existing.remoteDraftId ?? (existingPlan && existingPlan.mode !== 'create' ? existingPlan.remoteDraftId : undefined);
          if (identity(batch.preview, item.snapshot) === identity(other.preview, existing.snapshot) ||
            (plan && plan.mode !== 'create' && remoteId === plan.remoteDraftId)) overlaps.push({ batch: other, item: existing });
        }
      }
      for (const prior of overlaps) {
        const existing = prior.item;
        if (existing.state === 'failed' && !existing.mutationStarted) continue;
        if (!['draft_verified', 'submitted'].includes(existing.state)) {
          const same = canonical(item.snapshot) === canonical(existing.snapshot);
          reject(same ? 'DUPLICATE_CHAPTER' : 'CONFLICTING_VERSION', 'Unresolved approved operation requires reconciliation');
        }
      }
      const successes = overlaps.filter(prior => ['draft_verified', 'submitted'].includes(prior.item.state));
      const superseded = new Set(successes.flatMap(prior => {
        const predecessor = planFor(prior.batch.preview, prior.item.snapshot.chapterId)?.predecessor;
        return predecessor?.source === 'publication' ? [predecessor.operationId] : [];
      }));
      const heads = successes.filter(prior => !superseded.has(prior.item.id));
      const head = heads.at(-1);
      if (!head) {
        if (plan?.predecessor?.source === 'publication') reject('CONFLICTING_VERSION', 'Approved predecessor is not the current successful head');
        continue;
      }
      if (identity(batch.preview, item.snapshot) !== identity(head.batch.preview, head.item.snapshot))
        reject('CONFLICTING_VERSION', 'Remote chapter belongs to another approved logical chapter');
      const same = canonical(item.snapshot) === canonical(head.item.snapshot);
      // Preserve the original exact saved-draft -> review transition for legacy previews only.
      if (!plan && same && batch.preview.action === 'submit_review' && head.batch.preview.action === 'save_draft' && head.item.state === 'draft_verified') continue;
      if (!plan || plan.mode === 'create' || head.item.state !== 'draft_verified' ||
        plan.predecessor?.source !== 'publication' || plan.predecessor.operationId !== head.item.id ||
        plan.remoteDraftId !== head.item.remoteDraftId || !head.item.remoteFingerprint ||
        plan.expectedRemoteFingerprint !== head.item.remoteFingerprint)
        reject(same ? 'DUPLICATE_CHAPTER' : 'CONFLICTING_VERSION', 'A revision requires the exact current verified remote predecessor');
      if (same && batch.preview.action === head.batch.preview.action)
        reject('DUPLICATE_CHAPTER', 'The exact approved action already completed');
    }
  }
  approve(id: string, approvalHash: string, provenance: { mode: 'manual' | 'automatic'; source: 'prepare' | 'start' } = { mode: 'manual', source: 'start' }): PublicationBatch {
    const batch = this.batch(id);
    this.checkHash(batch.preview);
    if (approvalHash !== batch.preview.hash) reject('APPROVAL_MISMATCH', 'Exact preview hash approval required');
    if (batch.approvalHash === approvalHash) return this.get(id);
    if (batch.state !== 'preview') reject('INVALID_STATE', 'Only a preview can be approved');
    if (Date.parse(this.now()) - Date.parse(batch.preview.createdAt) >= 10 * 60 * 1000)
      reject('PREVIEW_EXPIRED', 'Preview expired; create a new read-only preview');
    this.checkConflicts(batch);
    this.change(() => { batch.approvalHash = approvalHash; batch.approval = { ...provenance, approvedAt: this.now(), hash: approvalHash }; batch.state = 'queued'; batch.updatedAt = this.now(); });
    return this.get(id);
  }
  start(id: string, input: { approvalHash: string; requestId: string }): PublicationBatch {
    const batch = this.batch(id);
    text(input.requestId, 'requestId');
    this.checkHash(batch.preview);
    if (batch.approvalHash !== input.approvalHash || batch.preview.hash !== input.approvalHash)
      reject('APPROVAL_MISMATCH', 'Exact approved preview hash required');
    const owner = this.batches.find(b => b.startRequestIds.includes(input.requestId));
    if (owner) {
      if (owner.id !== id) reject('REQUEST_CONFLICT', 'Start request belongs to another batch');
      return this.get(id);
    }
    if (this.tasks.has(id)) {
      this.change(() => { batch.startRequestIds.push(input.requestId); batch.updatedAt = this.now(); });
      return this.get(id);
    }
    if (!['queued', 'paused'].includes(batch.state) || batch.items.some(i => ['failed', 'unknown', 'running'].includes(i.state)))
      reject('INVALID_STATE', 'Only safe queued or paused batches may start; failure/unknown requires manual reconciliation');
    this.change(() => { batch.startRequestIds.push(input.requestId); batch.pauseRequested = false; batch.state = 'queued'; batch.updatedAt = this.now(); });
    const task = this.tail.then(() => this.run(id));
    // All errors remain durable at the last successful checkpoint. No automatic retry.
    const settled = task.catch(() => undefined).finally(() => { if (this.tasks.get(id) === settled) this.tasks.delete(id); });
    this.tasks.set(id, settled);
    this.tail = settled;
    return this.get(id);
  }
  pause(id: string): PublicationBatch {
    const batch = this.batch(id);
    if (!['queued', 'running', 'paused'].includes(batch.state)) reject('INVALID_STATE', 'Batch cannot be paused');
    this.change(() => { batch.pauseRequested = true; if (batch.state !== 'running') batch.state = 'paused'; batch.updatedAt = this.now(); });
    return this.get(id);
  }
  async reconcile(id: string, candidates: Record<string, string> = {}): Promise<PublicationBatch> {
    const initial = this.get(id);
    if (this.tasks.has(id) || initial.state !== 'unknown') reject('INVALID_STATE', 'Only an idle unknown batch can be reconciled');
    if (!this.hooks.reconcile) reject('RECONCILIATION_UNAVAILABLE', 'Read-only reconciliation is unavailable');
    for (const [itemId, candidate] of Object.entries(candidates)) {
      const item = initial.items.find(value => value.id === itemId && value.state === 'unknown');
      if (!item || !/^[A-Za-z0-9_-]{2,160}$/.test(candidate)) reject('INVALID_RECONCILIATION', 'Invalid unknown item or remote chapter ID');
      const plan = planFor(initial.preview, item.snapshot.chapterId);
      const pinned = item.remoteDraftId ?? (plan && plan.mode !== 'create' ? plan.remoteDraftId : undefined);
      if (pinned && pinned !== candidate) reject('INVALID_RECONCILIATION', 'Cannot replace the known remote chapter ID');
    }
    let release: (() => void | Promise<void>) | undefined;
    try {
      release = await this.hooks.acquire?.(initial.preview);
      for (const item of initial.items.filter(value => value.state === 'unknown')) {
        const plan = planFor(initial.preview, item.snapshot.chapterId);
        const knownId = item.remoteDraftId ?? (plan && plan.mode !== 'create' ? plan.remoteDraftId : candidates[item.id]);
        let evidence: Awaited<ReturnType<NonNullable<PublicationQueueHooks['reconcile']>>>;
        try { evidence = knownId ? await this.hooks.reconcile(initial.preview, { ...item, remoteDraftId: knownId }) : undefined; } catch { evidence = undefined; }
        const proven = !!evidence && evidence.remoteDraftId === knownId && !!evidence.remoteFingerprint &&
          evidence.state === (initial.preview.action === 'save_draft' ? 'draft_verified' : 'submitted');
        this.change(() => {
          const current = this.batch(id).items.find(value => value.id === item.id)!;
          current.reconciliation = { checkedAt: this.now(), outcome: proven && evidence ? evidence.state : 'unproven' };
          if (proven && evidence) {
            current.state = evidence.state; current.remoteDraftId = evidence.remoteDraftId;
            current.remoteFingerprint = evidence.remoteFingerprint; delete current.error;
          }
          const batch = this.batch(id);
          batch.state = batch.items.some(value => value.state === 'unknown') ? 'unknown' :
            batch.items.every(value => ['draft_verified', 'submitted'].includes(value.state)) ? 'completed' : 'paused';
          batch.pauseRequested = true; batch.updatedAt = this.now();
          if (batch.state !== 'unknown') delete batch.error;
        });
      }
      return this.get(id);
    } finally { await release?.(); }
  }
  clearStaging(projectId: string) {
    if (this.batches.some(batch => batch.preview.target.projectId === projectId && (this.tasks.has(batch.id) || ['queued', 'running'].includes(batch.state))))
      reject('INVALID_STATE', 'Cannot clear active publication batches');
    if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, `${this.filePath}.staging-${Date.now()}.bak`);
    this.change(() => { this.batches = this.batches.filter(batch => batch.preview.target.projectId !== projectId); });
  }
  async waitForIdle(id?: string): Promise<void> {
    if (id) await this.tasks.get(id); else await this.tail;
  }
  private async run(id: string): Promise<void> {
    if (this.batch(id).pauseRequested || this.batch(id).state !== 'queued') return;
    let release: (() => void | Promise<void>) | undefined;
    let activeItemId: string | undefined;
    try {
      const approved = this.get(id).preview;
      release = await this.hooks.acquire?.(approved);
      if (this.batch(id).pauseRequested) return;
      this.checkConflicts(this.batch(id));
      await this.hooks.validate(approved, this.get(id).items);
      if (this.batch(id).pauseRequested) return;
      this.change(() => { this.batch(id).state = 'running'; });
      for (const itemId of this.batch(id).items.map(i => i.id)) {
        const batch = this.batch(id);
        if (batch.pauseRequested) break;
        const item = batch.items.find(i => i.id === itemId)!;
        if (item.state !== 'queued') continue;
        activeItemId = itemId;
        // Revalidate ALL snapshots before EACH chapter; validation is read-only.
        await this.hooks.validate(this.get(id).preview, this.get(id).items);
        if (this.batch(id).pauseRequested) break;
        this.change(() => { this.batch(id).items.find(i => i.id === itemId)!.state = 'running'; });
        const context: PublicationExecutionContext = {
          beforeMutation: () => this.change(() => {
            const current = this.batch(id).items.find(i => i.id === itemId)!;
            if (current.state !== 'running' || this.batch(id).state !== 'running')
              reject('INVALID_STATE', 'Mutation checkpoint only valid for the active item');
            current.mutationStarted = true;
          }),
          identified: remoteDraftId => this.change(() => {
            const current = this.batch(id).items.find(i => i.id === itemId)!;
            if (current.state !== 'running' || this.batch(id).state !== 'running')
              reject('INVALID_STATE', 'Identification only valid for the active item');
            if (!current.mutationStarted) reject('MUTATION_NOT_CHECKPOINTED', 'Persist mutation intent first');
            const identified = text(remoteDraftId, 'remoteDraftId');
            const plan = planFor(this.batch(id).preview, current.snapshot.chapterId);
            if (plan && plan.mode !== 'create' && identified !== plan.remoteDraftId)
              reject('REMOTE_ID_CHANGED', 'Identification changed approved remote target');
            const prior = this.findVerifiedDraft(this.batch(id).preview, current.snapshot);
            if ((current.remoteDraftId && current.remoteDraftId !== identified) ||
              (prior?.remoteDraftId && prior.remoteDraftId !== identified))
              reject('REMOTE_ID_CHANGED', 'Remote draft identity changed');
            current.remoteDraftId = identified;
          }),
        };
        const result = await this.hooks.execute(this.get(id).preview, freeze(clone(item)), context);
        if (!['draft_verified', 'submitted'].includes(result.state) ||
          (approved.action === 'submit_review' && result.state !== 'submitted') ||
          (approved.action === 'save_draft' && result.state !== 'draft_verified'))
          reject('INVALID_OUTCOME', 'Execution must confirm exactly the approved action, never infer published');
        const finalItem = this.batch(id).items.find(i => i.id === itemId)!;
        const plan = planFor(approved, finalItem.snapshot.chapterId);
        if (plan) {
          const remoteId = result.remoteDraftId ?? finalItem.remoteDraftId;
          if (!remoteId || (plan.mode !== 'create' && remoteId !== plan.remoteDraftId))
            reject('REMOTE_ID_CHANGED', 'Outcome must identify the exact approved remote chapter');
          text(result.remoteFingerprint, 'verified remote fingerprint');
        }
        const priorDraft = this.findVerifiedDraft(approved, finalItem.snapshot);
        if ((result.remoteDraftId && finalItem.remoteDraftId && result.remoteDraftId !== finalItem.remoteDraftId) ||
          (priorDraft?.remoteDraftId && (result.remoteDraftId ?? finalItem.remoteDraftId) !== priorDraft.remoteDraftId))
          reject('REMOTE_ID_CHANGED', 'Execution outcome changed exact remote draft identity');
        this.change(() => {
          const current = this.batch(id).items.find(i => i.id === itemId)!;
          current.state = result.state;
          if (result.remoteDraftId) current.remoteDraftId = text(result.remoteDraftId, 'remoteDraftId');
          if (result.remoteFingerprint) current.remoteFingerprint = text(result.remoteFingerprint, 'remoteFingerprint');
          this.batch(id).updatedAt = this.now();
        });
        activeItemId = undefined;
      }
      this.change(() => {
        const batch = this.batch(id);
        batch.state = batch.items.every(i => ['draft_verified', 'submitted'].includes(i.state)) ? 'completed' : 'paused';
        batch.updatedAt = this.now();
      });
    } catch {
      this.change(() => {
        const batch = this.batch(id);
        const item = batch.items.find(i => i.id === activeItemId);
        if (item) { item.state = item.mutationStarted ? 'unknown' : 'failed'; item.error = item.mutationStarted ? 'Outcome unknown; manual reconciliation required.' : 'Validation or execution failed before mutation.'; }
        batch.state = item?.mutationStarted ? 'unknown' : 'failed';
        // Do not persist arbitrary hook errors: they can contain credential/browser data.
        batch.error = item?.mutationStarted ? 'Outcome unknown; stopped without retry.' : 'Read-only validation or execution failed; stopped.';
        batch.updatedAt = this.now();
      });
    } finally { await release?.(); }
  }
}
