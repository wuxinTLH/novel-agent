import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  DraftOperation,
  DraftPreparation,
  DraftReceipt,
  DraftSnapshot,
  PlatformConnection,
  PlatformWork,
  ProjectPlatformWorkLink,
} from '../shared/platforms.js';

export interface ConnectionRecord extends Omit<PlatformConnection, 'hasCredential' | 'status'> {
  credentialRef: string;
  authKind: 'mock_token' | 'manual_browser';
  needsReauth?: boolean;
}
const defaultCapabilities = {
  paired: false,
  accountVerified: false,
  listWorks: false,
  saveDraft: false,
};
export interface OperationRecord {
  hash: string;
  state: 'pending' | 'succeeded' | 'failed' | 'unknown';
  projectId?: string;
  status?: number;
  body?: unknown;
}
export interface DraftOperationRecord extends DraftOperation {
  snapshot: DraftSnapshot;
  businessKey: string;
  preparationId: string;
  requestKeys: string[];
}
interface PlatformData {
  version: 2;
  connections: ConnectionRecord[];
  links: ProjectPlatformWorkLink[];
  mockWorks: Record<string, PlatformWork[]>;
  operations: Record<string, OperationRecord>;
  preparations: DraftPreparation[];
  draftOperations: DraftOperationRecord[];
  receipts: DraftReceipt[];
  archives: { archivedAt: string; reason: string; data: unknown }[];
}
const id = z.string().min(1).max(512);
const recordSchema = z.record(z.string(), z.unknown());
const legacySchema = z
  .object({
    version: z.literal(1),
    connections: z.array(
      z
        .object({
          id,
          projectId: id,
          providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
          accountName: z.string(),
          credentialRef: id,
          createdAt: z.string(),
          lastCheckedAt: z.string().optional(),
        })
        .passthrough(),
    ),
    links: z.array(
      z
        .object({
          id,
          projectId: id,
          connectionId: id,
          providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
          remoteWorkId: id,
          title: z.string(),
          revision: z.string(),
          lastSyncedAt: z.string(),
        })
        .passthrough(),
    ),
    mockWorks: z.record(
      z.string(),
      z.array(
        z
          .object({
            id,
            providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
            title: z.string(),
            description: z.string(),
            genre: z.string(),
            revision: z.string(),
            chapterCount: z.number(),
            updatedAt: z.string(),
          })
          .passthrough(),
      ),
    ),
    chapters: recordSchema.optional(),
    operations: recordSchema,
  })
  .passthrough();
const connectionSchema = z.object({
  id,
  projectId: id,
  providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
  accountId: id,
  accountName: z.string().min(1),
  credentialRef: id,
  createdAt: z.string(),
  lastCheckedAt: z.string().optional(),
  needsReauth: z.boolean().optional(),
  authKind: z.enum(['mock_token', 'manual_browser']),
});
const snapshotSchema = z.object({
  chapterId: id,
  number: z.number().int().positive(),
  revision: z.number().int().positive(),
  title: z.string(),
  content: z.string(),
  paragraphs: z.array(z.string()),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const preparationSchema = z.object({
  id,
  projectId: id,
  connectionId: id,
  providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
  accountId: id,
  accountName: z.string(),
  linkId: id,
  remoteWorkId: id,
  workTitle: z.string(),
  snapshot: snapshotSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  warning: z.string(),
});
const draftSchema = z.object({
  id,
  projectId: id,
  connectionId: id,
  providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
  accountId: id,
  remoteWorkId: id,
  chapterId: id,
  chapterNumber: z.number().int().positive(),
  revision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  state: z.enum(['queued', 'running', 'verified', 'failed', 'unknown']),
  mutationStarted: z.boolean(),
  remoteDraftId: id.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  verifiedAt: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  snapshot: snapshotSchema,
  businessKey: id,
  preparationId: id,
  requestKeys: z.array(id),
});
const receiptSchema = z.object({
  id,
  operationId: id,
  projectId: id,
  connectionId: id,
  providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
  accountId: id,
  remoteWorkId: id,
  remoteDraftId: id,
  chapterId: id,
  revision: z.number().int().positive(),
  contentHash: z.string(),
  title: z.string(),
  verifiedAt: z.string(),
});
const dataSchema = z.object({
  version: z.literal(2),
  connections: z.array(connectionSchema),
  links: z.array(
    z.object({
      id,
      projectId: id,
      connectionId: id,
      providerId: z.enum(['qidian', 'qimao', 'tomato', 'mock']),
      accountId: id,
      remoteWorkId: id,
      title: z.string(),
      revision: z.string(),
      lastSyncedAt: z.string(),
    }),
  ),
  mockWorks: legacySchema.shape.mockWorks,
  operations: z.record(
    z.string(),
    z.object({
      hash: z.string(),
      state: z.enum(['pending', 'succeeded', 'failed', 'unknown']),
      projectId: z.string().optional(),
      status: z.number().optional(),
      body: z.unknown().optional(),
    }),
  ),
  preparations: z.array(preparationSchema),
  draftOperations: z.array(draftSchema),
  receipts: z.array(receiptSchema),
  archives: z.array(z.object({ archivedAt: z.string(), reason: z.string(), data: z.unknown() })),
});

function validate(data: unknown): PlatformData {
  const parsed = dataSchema.safeParse(data);
  if (!parsed.success) throw new Error('平台数据格式或版本不受支持，原文件未修改。');
  const next = parsed.data as unknown as PlatformData;
  for (const connection of next.connections) connection.capabilities ||= { ...defaultCapabilities };
  for (const collection of [
    next.connections,
    next.links,
    next.preparations,
    next.draftOperations,
    next.receipts,
  ])
    if (new Set(collection.map((item) => item.id)).size !== collection.length)
      throw new Error('平台数据包含重复身份，原文件未修改。');
  for (const connection of next.connections)
    if ((connection.providerId === 'tomato') !== (connection.authKind === 'manual_browser'))
      throw new Error('平台认证类型不匹配，原文件未修改。');
  for (const link of next.links) {
    const connection = next.connections.find((item) => item.id === link.connectionId);
    if (
      !connection ||
      connection.projectId !== link.projectId ||
      connection.providerId !== link.providerId ||
      connection.accountId !== link.accountId
    )
      throw new Error('平台绑定身份不匹配，原文件未修改。');
  }
  for (const operation of next.draftOperations)
    if (
      operation.snapshot.chapterId !== operation.chapterId ||
      operation.snapshot.revision !== operation.revision ||
      operation.snapshot.contentHash !== operation.contentHash
    )
      throw new Error('草稿操作快照不一致，原文件未修改。');
  return next;
}
const empty = (): PlatformData => ({
  version: 2,
  connections: [],
  links: [],
  mockWorks: {},
  operations: {},
  preparations: [],
  draftOperations: [],
  receipts: [],
  archives: [],
});

export class PlatformStore {
  private file: string;
  private data: PlatformData;
  constructor(dir: string) {
    this.file = path.join(dir, 'platform-connections.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.data = empty();
      return;
    }
    const raw = fs.readFileSync(this.file, 'utf8');
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error('平台数据无法解析，原文件未修改。');
    }
    let changed = false;
    if ((input as { version?: unknown })?.version === 1) {
      const parsed = legacySchema.safeParse(input);
      if (!parsed.success) throw new Error('旧平台数据无效，原文件未修改。');
      const old = parsed.data;
      const migrated = empty();
      migrated.archives.push({
        archivedAt: new Date().toISOString(),
        reason: 'v1 本地番茄模拟及无来源操作记录隔离；不是远端数据。',
        data: input,
      });
      migrated.connections = old.connections
        .filter((item) => item.providerId !== 'tomato')
        .map((item) => ({
          ...item,
          capabilities: { ...defaultCapabilities, paired: true },
          accountId: `${item.providerId}:${item.id}`,
          authKind: 'mock_token' as const,
        }));
      migrated.links = old.links
        .filter(
          (link) =>
            link.providerId !== 'tomato' &&
            migrated.connections.some((connection) => connection.id === link.connectionId),
        )
        .map((link) => ({
          ...link,
          accountId: migrated.connections.find((connection) => connection.id === link.connectionId)!
            .accountId,
        }));
      for (const connection of migrated.connections)
        migrated.mockWorks[connection.id] = (old.mockWorks[connection.id] || []).filter(
          (work) => work.providerId === connection.providerId,
        );
      input = validate(migrated);
      // Exclusive backup preserves even unknown legacy fields; never overwrite an earlier archive.
      const backup = this.file + '.v1.bak';
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
      changed = true;
    }
    this.data = validate(input);
    for (const operation of Object.values(this.data.operations))
      if (operation.state === 'pending') {
        operation.state = 'unknown';
        changed = true;
      }
    for (const operation of this.data.draftOperations)
      if (operation.state === 'queued' || operation.state === 'running') {
        operation.state = 'unknown';
        operation.errorCode = 'PLATFORM_RECOVERY_REQUIRED';
        operation.error = '服务在上次操作中停止；只能先只读核对，禁止自动重发。';
        operation.updatedAt = new Date().toISOString();
        changed = true;
      }
    if (changed) this.persist(this.data);
  }
  private persist(next: PlatformData) {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  private change(fn: (data: PlatformData) => void) {
    const next = structuredClone(this.data);
    fn(next);
    validate(next);
    this.persist(next);
    this.data = next;
  }
  get legacyArchived() {
    return this.data.archives.length > 0;
  }
  connections(projectId: string) {
    return structuredClone(this.data.connections.filter((c) => c.projectId === projectId));
  }
  connection(projectId: string, id: string) {
    return this.connections(projectId).find((c) => c.id === id);
  }
  allConnections() {
    return structuredClone(this.data.connections);
  }
  putConnection(connection: ConnectionRecord) {
    this.change((data) => {
      data.connections = [...data.connections.filter((c) => c.id !== connection.id), connection];
    });
  }
  deleteConnection(id: string) {
    this.change((data) => {
      data.connections = data.connections.filter((c) => c.id !== id);
      data.links = data.links.filter((link) => link.connectionId !== id);
      data.preparations = data.preparations.filter((item) => item.connectionId !== id);
      delete data.mockWorks[id];
    });
  }
  links(projectId: string) {
    return structuredClone(this.data.links.filter((link) => link.projectId === projectId));
  }
  putLink(link: ProjectPlatformWorkLink) {
    this.change((data) => {
      data.links = [...data.links.filter((item) => item.id !== link.id), link];
    });
  }
  deleteLink(id: string) {
    this.change((data) => {
      data.links = data.links.filter((link) => link.id !== id);
      data.preparations = data.preparations.filter((item) => item.linkId !== id);
    });
  }
  works(connectionId: string) {
    return structuredClone(this.data.mockWorks[connectionId] || []);
  }
  putWork(connectionId: string, work: PlatformWork) {
    this.change((data) => {
      if (work.providerId !== 'mock') throw new Error('真实作品不写入模拟作品存储。');
      data.mockWorks[connectionId] = [
        ...(data.mockWorks[connectionId] || []).filter((w) => w.id !== work.id),
        work,
      ];
    });
  }
  operation(key: string) {
    return structuredClone(this.data.operations[key]);
  }
  putOperation(key: string, record: OperationRecord) {
    this.change((data) => {
      data.operations[key] = record;
    });
  }
  preparation(projectId: string, id: string) {
    return structuredClone(this.data.preparations.find((p) => p.projectId === projectId && p.id === id));
  }
  putPreparation(value: DraftPreparation) {
    this.change((data) => {
      data.preparations = data.preparations.filter(
        (p) => p.id !== value.id && Date.parse(p.expiresAt) > Date.now(),
      );
      data.preparations.push(value);
    });
  }
  draftOperations(projectId?: string) {
    return structuredClone(this.data.draftOperations.filter((o) => !projectId || o.projectId === projectId));
  }
  draftOperation(projectId: string, id: string) {
    return this.draftOperations(projectId).find((o) => o.id === id);
  }
  putDraftOperation(operation: DraftOperationRecord) {
    this.change((data) => {
      data.draftOperations = [...data.draftOperations.filter((o) => o.id !== operation.id), operation];
    });
  }
  receipts(projectId: string) {
    return structuredClone(this.data.receipts.filter((r) => r.projectId === projectId));
  }
  verifyDraft(operation: DraftOperationRecord, receipt: DraftReceipt) {
    this.change((data) => {
      data.draftOperations = [...data.draftOperations.filter((o) => o.id !== operation.id), operation];
      data.receipts = [...data.receipts.filter((r) => r.operationId !== operation.id), receipt];
    });
  }
  removeProject(projectId: string) {
    this.change((data) => {
      const connections = data.connections.filter((c) => c.projectId === projectId);
      for (const connection of connections) delete data.mockWorks[connection.id];
      data.connections = data.connections.filter((c) => c.projectId !== projectId);
      data.links = data.links.filter((l) => l.projectId !== projectId);
      data.preparations = data.preparations.filter((p) => p.projectId !== projectId);
      // Keep historical receipts and ambiguous operations for business-key deduplication.
      for (const [key, value] of Object.entries(data.operations))
        if (value.projectId === projectId) delete data.operations[key];
    });
  }
}
