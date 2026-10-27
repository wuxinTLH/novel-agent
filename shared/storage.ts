import { z } from 'zod';
import { sqlConnectConfigSchema } from './sqlconnect.js';

const identity = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0') && !value.endsWith(' '));
export const storageProfileSchema = z
  .object({
    id: identity,
    label: z.string().max(200).optional(),
    connection: sqlConnectConfigSchema,
  })
  .strict();
export const storageConfigSchema = z
  .object({
    version: z.literal(3),
    defaultProfileId: identity,
    profiles: z.array(storageProfileSchema).min(1),
    ownerProfiles: z.array(z.object({ ownerId: identity, profileId: identity }).strict()).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.profiles.map((profile) => profile.id));
    if (
      ids.size !== value.profiles.length ||
      !ids.has(value.defaultProfileId) ||
      value.ownerProfiles.some((binding) => !ids.has(binding.profileId)) ||
      new Set(value.ownerProfiles.map((binding) => binding.ownerId)).size !== value.ownerProfiles.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate or unknown storage profile binding.' });
  });
export type StorageConfig = z.output<typeof storageConfigSchema>;
export type StorageProfile = z.output<typeof storageProfileSchema>;
export interface StoredDocument {
  revision: number;
  content: string;
}
export interface ImportDocument {
  key: string;
  content: string;
}
export interface ImportDocumentsResult {
  imported: boolean;
  count: number;
}
export interface StorageSnapshot {
  version: 3;
  owners: Array<{
    ownerId: string;
    revision: number;
    documents: Array<ImportDocument & { revision: number }>;
    receipts: Array<{ sourceHash: string; documentCount: number }>;
  }>;
}
/** expectedRevision=0 means absent. All writes resolve only after acknowledged commit. */
export interface AsyncDocumentStorage {
  migrate(): Promise<void>;
  readDocument(ownerId: string, key: string): Promise<StoredDocument | null>;
  writeDocument(ownerId: string, key: string, content: string, expectedRevision: number): Promise<number>;
  importDocuments(
    ownerId: string,
    sourceHash: string,
    documents: ImportDocument[],
  ): Promise<ImportDocumentsResult>;
  exportSnapshot(): Promise<StorageSnapshot>;
  /** Only imports into an empty repository. Any existing owner/document/receipt rejects atomically. */
  importSnapshot(snapshot: StorageSnapshot): Promise<void>;
  close(): Promise<void>;
}
export function profileForOwner(config: StorageConfig, ownerId: string): StorageProfile {
  const parsed = storageConfigSchema.parse(config);
  const id =
    parsed.ownerProfiles.find((binding) => binding.ownerId === ownerId)?.profileId ?? parsed.defaultProfileId;
  return parsed.profiles.find((profile) => profile.id === id)!;
}
