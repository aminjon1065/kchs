import { eq } from 'drizzle-orm'
import { buckets } from '~/kernel/storage/s3.js'
import { db } from '~/shared/db/client.js'
import { files } from '~/shared/db/schema/index.js'

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
