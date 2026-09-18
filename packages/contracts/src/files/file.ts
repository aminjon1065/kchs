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

/** Превью страницы или миниатюра, сформированные движком (09-files.md §3). */
export const FilePreviewKind = z.enum(['thumbnail', 'page', 'web'])
export type FilePreviewKind = z.infer<typeof FilePreviewKind>

export const FilePreview = z.object({
  kind: FilePreviewKind,
  page: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  mime: z.string(),
  /** Подписанная ссылка с коротким сроком жизни. */
  url: z.string(),
})
export type FilePreview = z.infer<typeof FilePreview>

export const FilePreviews = z.object({
  previewStatus: PreviewStatus,
  textStatus: PreviewStatus,
  /** Число страниц документа (PDF и офисные форматы), если известно. */
  pages: z.number().int().nullable(),
  items: z.array(FilePreview),
})
export type FilePreviews = z.infer<typeof FilePreviews>

/**
 * Результат обработки версии файла движком: превью уже лежат в бакете превью,
 * метаданные и текст записывает api (движок не пишет в базу напрямую).
 */
export const FileProcessedInput = z.object({
  versionId: Uuid,
  previewStatus: z.enum(['ready', 'failed', 'unsupported']),
  textStatus: z.enum(['ready', 'failed', 'unsupported']),
  pages: z.number().int().min(0).nullable().default(null),
  previews: z
    .array(
      z.object({
        kind: FilePreviewKind,
        page: z.number().int().min(1).nullable().default(null),
        storageKey: z.string().min(1).max(1024),
        width: z.number().int().nullable().default(null),
        height: z.number().int().nullable().default(null),
        mime: z.string().max(100).default('image/webp'),
      }),
    )
    .max(500)
    .default([]),
  /** Извлечённый текст; ограничен, чтобы не раздувать базу и индекс. */
  text: z.string().max(2_000_000).nullable().default(null),
  lang: z.string().max(32).nullable().default(null),
  error: z.string().max(4000).nullable().default(null),
})
export type FileProcessedInput = z.infer<typeof FileProcessedInput>

/** Извлечённый текст для просмотрщика текстовых файлов и поиска по содержимому. */
export const FileText = z.object({
  status: PreviewStatus,
  text: z.string().nullable(),
  lang: z.string().nullable(),
  /** Текст длиннее отдаваемой части — полный доступен скачиванием. */
  truncated: z.boolean(),
})
export type FileText = z.infer<typeof FileText>
