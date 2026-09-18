import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

export const PreviewStatus = z.enum([
  'none',
  'queued',
  'processing',
  'ready',
  'failed',
  'unsupported',
])
export type PreviewStatus = z.infer<typeof PreviewStatus>

export const FileVersion = z.object({
  id: Uuid,
  number: z.number().int(),
  size: z.number().int(),
  checksum: z.string(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
  note: z.string().nullable(),
})
export type FileVersion = z.infer<typeof FileVersion>

export const FileRecord = z.object({
  id: Uuid,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  spaceId: Uuid,
  folderId: Uuid.nullable(),
  checksum: z.string().nullable(),
  currentVersionId: Uuid.nullable(),
  versionNumber: z.number().int(),
  previewStatus: PreviewStatus,
  textStatus: PreviewStatus,
  lockedBy: UserRef.nullable(),
  lockedAt: Timestamp.nullable(),
  owner: UserRef.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type FileRecord = z.infer<typeof FileRecord>

/** Сессия загрузки: подписанные URL для multipart прямо в S3 (09-files.md §2). */
export const UploadSessionInput = z.object({
  name: z.string().min(1).max(400),
  size: z
    .number()
    .int()
    .min(0)
    .max(5 * 1024 ** 3),
  mime: z.string().max(200).default('application/octet-stream'),
  spaceId: Uuid,
  folderId: Uuid.nullable().optional(),
  /** Новая версия существующего файла. */
  fileId: Uuid.nullable().optional(),
  /** Прикрепить к объекту связью `attachment` после завершения. */
  attachToObjectId: Uuid.nullable().optional(),
  checksum: z.string().max(128).optional(),
})
export type UploadSessionInput = z.infer<typeof UploadSessionInput>

export const UploadPart = z.object({
  partNumber: z.number().int(),
  url: z.string(),
  size: z.number().int(),
})

export const UploadSession = z.object({
  uploadId: z.string(),
  storageKey: z.string(),
  parts: z.array(UploadPart),
  partSize: z.number().int(),
  expiresAt: Timestamp,
  /** Однокусочная загрузка мелких файлов: PUT по одному URL. */
  singlePutUrl: z.string().nullable(),
})
export type UploadSession = z.infer<typeof UploadSession>

export const UploadCompleteInput = z.object({
  uploadId: z.string(),
  storageKey: z.string(),
  parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).default([]),
  note: z.string().max(500).optional(),
})
export type UploadCompleteInput = z.infer<typeof UploadCompleteInput>

export const FolderRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  childCount: z.number().int().default(0),
  system: z.boolean().default(false),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type FolderRecord = z.infer<typeof FolderRecord>

export const FolderCreateInput = z.object({
  name: z.string().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
})
export type FolderCreateInput = z.infer<typeof FolderCreateInput>
