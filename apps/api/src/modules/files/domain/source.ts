import { and, eq } from 'drizzle-orm'
import { buckets } from '~/kernel/storage/s3.js'
import { db } from '~/shared/db/client.js'
import { files, fileVersions } from '../schema.js'

/** Текущая версия файла в хранилище: откуда движку читать исходник. */
export interface FileSource {
  fileId: string
  versionId: string
  name: string
  mime: string
  size: number
  bucket: string
  storageKey: string
}

/**
 * Для заданий движка других модулей (импорт пользователей и т. п.): права на
 * файл проверяет вызывающий код через `authorize(view)` до вызова.
 */
export async function fileSource(fileId: string): Promise<FileSource | null> {
  const [row] = await db()
    .select({
      id: files.id,
      name: files.name,
      mime: files.mime,
      size: files.size,
      storageKey: files.storageKey,
      currentVersionId: files.currentVersionId,
    })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1)
  if (!row?.currentVersionId) return null
  return {
    fileId: row.id,
    versionId: row.currentVersionId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    bucket: buckets.files(),
    storageKey: row.storageKey,
  }
}

/**
 * Конкретная версия файла в хранилище (ADR-0197): версия документа закреплена за
 * версией файла, и письмо адресату или копия с водяным знаком берут её, а не
 * текущую. Без версии — текущая. Права проверяет вызывающий.
 */
export async function fileVersionSource(
  fileId: string,
  versionId: string | null | undefined,
): Promise<FileSource | null> {
  if (!versionId) return fileSource(fileId)
  const [row] = await db()
    .select({
      name: files.name,
      mime: fileVersions.mime,
      size: fileVersions.size,
      storageKey: fileVersions.storageKey,
    })
    .from(fileVersions)
    .innerJoin(files, eq(files.id, fileVersions.fileId))
    .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.id, versionId)))
    .limit(1)
  if (!row) return null
  return {
    fileId,
    versionId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    bucket: buckets.files(),
    storageKey: row.storageKey,
  }
}
