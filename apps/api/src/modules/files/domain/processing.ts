import type { FilePreviews, FileProcessedInput, FileText } from '@kchs/contracts'
import { and, asc, eq, isNotNull, or, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { buckets, deleteObject, signedGetUrl } from '~/kernel/storage/s3.js'
import type { Ctx } from '~/shared/context.js'
import { systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { filePreviews, files, fileTexts, fileVersions, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'

/** Превью живут рядом с версией: `…/{versionId}/preview/…` в бакете превью. */
export function previewPrefix(storageKey: string): string {
  const slash = storageKey.lastIndexOf('/')
  return `${storageKey.slice(0, slash)}/preview/`
}

interface ProcessTarget {
  fileId: string
  spaceId: string | null
  versionId: string
  storageKey: string
  mime: string
  name: string
}

/**
 * Превью и текст файла (09-files.md §3–4): задание движка `render:file.process`
 * ставится в транзакции версии, результат движок сообщает внутренним маршрутом.
 */
export const FileProcessing = {
  async schedule(tx: Executor, ctx: Ctx, target: ProcessTarget): Promise<string> {
    return JobService.schedule(tx, ctx, {
      queue: 'render',
      name: 'file.process',
      objectId: target.fileId,
      idempotencyKey: `file.process:${target.versionId}`,
      data: {
        fileId: target.fileId,
        versionId: target.versionId,
        name: target.name,
        mime: target.mime,
        bucket: buckets.files(),
        storageKey: target.storageKey,
        previewBucket: buckets.previews(),
        previewPrefix: previewPrefix(target.storageKey),
      },
      options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    })
  },

  /**
   * Результат движка. Превью устаревшей версии не принимаются, ключи превью
   * обязаны лежать под префиксом версии — движок не может подменить чужой объект.
   */
  async applyResult(fileId: string, input: FileProcessedInput): Promise<{ stale: boolean }> {
    const removedKeys: string[] = []

    const outcome = await db().transaction(async (tx) => {
      const [file] = await tx
        .select({
          id: files.id,
          name: files.name,
          currentVersionId: files.currentVersionId,
          storageKey: files.storageKey,
          spaceId: objects.spaceId,
        })
        .from(files)
        .innerJoin(objects, eq(objects.id, files.id))
        .where(eq(files.id, fileId))
        .limit(1)
      if (!file) throw errors.notFound('Файл')
      if (file.currentVersionId !== input.versionId) return { stale: true }

      const prefix = previewPrefix(file.storageKey)
      const foreign = input.previews.find((p) => !p.storageKey.startsWith(prefix))
      if (foreign) {
        throw errors.validation('Превью вне каталога версии', [
          { path: 'previews.storageKey', message: foreign.storageKey },
        ])
      }

      const previous = await tx
        .delete(filePreviews)
        .where(eq(filePreviews.fileId, fileId))
        .returning({ storageKey: filePreviews.storageKey })
      const kept = new Set(input.previews.map((p) => p.storageKey))
      removedKeys.push(...previous.map((p) => p.storageKey).filter((key) => !kept.has(key)))

      if (input.previews.length > 0) {
        await tx.insert(filePreviews).values(
          input.previews.map((preview) => ({
            id: newId(),
            fileId,
            versionId: input.versionId,
            kind: preview.kind,
            page: preview.page,
            storageKey: preview.storageKey,
            width: preview.width,
            height: preview.height,
            mime: preview.mime,
          })),
        )
      }

      if (input.textStatus === 'ready' && input.text !== null) {
        await tx
          .insert(fileTexts)
          .values({ fileId, text: input.text, lang: input.lang, pages: input.pages })
          .onConflictDoUpdate({
            target: fileTexts.fileId,
            set: {
              text: input.text,
              lang: input.lang,
              pages: input.pages,
              extractedAt: sql`now()`,
            },
          })
      } else {
        // Текст прежней версии к новой не относится
        await tx.delete(fileTexts).where(eq(fileTexts.fileId, fileId))
      }

      await tx
        .update(files)
        .set({ previewStatus: input.previewStatus, textStatus: input.textStatus })
        .where(eq(files.id, fileId))

      const ctx = systemCtx('files.process')
      const object = { id: fileId, type: 'file', spaceId: file.spaceId, title: file.name }
      await publishEvent(tx, ctx, {
        type: 'file.previewed',
        object,
        payload: { status: input.previewStatus },
      })
      if (input.textStatus === 'ready') {
        await publishEvent(tx, ctx, {
          type: 'file.text_extracted',
          object,
          payload: { chars: input.text?.length ?? 0 },
        })
      }
      return { stale: false }
    })

    for (const key of removedKeys) await deleteObject(key, buckets.previews())
    if (input.error) {
      logger().warn({ fileId, error: input.error }, 'обработка файла завершилась с замечаниями')
    }
    return outcome
  },

  /** Превью текущей версии с короткоживущими ссылками для просмотрщика. */
  async previews(fileId: string): Promise<FilePreviews> {
    const [file] = await db()
      .select({
        previewStatus: files.previewStatus,
        textStatus: files.textStatus,
        currentVersionId: files.currentVersionId,
      })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1)
    if (!file) throw errors.notFound('Файл')

    const rows = await db()
      .select()
      .from(filePreviews)
      .where(eq(filePreviews.fileId, fileId))
      .orderBy(asc(filePreviews.kind), asc(filePreviews.page))
    const [text] = await db()
      .select({ pages: fileTexts.pages })
      .from(fileTexts)
      .where(eq(fileTexts.fileId, fileId))
      .limit(1)

    const pagePreviews = rows.filter((r) => r.kind === 'page')
    const items = await Promise.all(
      rows.map(async (row) => ({
        kind: row.kind as FilePreviews['items'][number]['kind'],
        page: row.page,
        width: row.width,
        height: row.height,
        mime: row.mime,
        url: await signedGetUrl(row.storageKey, { bucket: buckets.previews(), inline: true }),
      })),
    )

    return {
      previewStatus: file.previewStatus as FilePreviews['previewStatus'],
      textStatus: file.textStatus as FilePreviews['textStatus'],
      pages: text?.pages ?? (pagePreviews.length > 0 ? pagePreviews.length : null),
      items,
      watermark: null,
    }
  },

  /** Текст для просмотрщика: первые `limit` символов извлечённого текста. */
  async text(fileId: string, limit = 200_000): Promise<FileText> {
    const [file] = await db()
      .select({ textStatus: files.textStatus })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1)
    if (!file) throw errors.notFound('Файл')
    const [row] = await db()
      .select({
        text: sql<string>`left(${fileTexts.text}, ${limit})`,
        length: sql<number>`length(${fileTexts.text})`,
        lang: fileTexts.lang,
      })
      .from(fileTexts)
      .where(eq(fileTexts.fileId, fileId))
      .limit(1)
    return {
      status: file.textStatus as FileText['status'],
      text: row?.text ?? null,
      lang: row?.lang ?? null,
      truncated: (row?.length ?? 0) > limit,
    }
  },

  /**
   * Файлы, загруженные до появления обработки или потерявшие задание:
   * ставим задание по текущей версии (идемпотентно по ключу версии).
   */
  async schedulePending(limit = 100): Promise<number> {
    const rows = await db()
      .select({
        fileId: files.id,
        name: files.name,
        mime: files.mime,
        storageKey: files.storageKey,
        versionId: files.currentVersionId,
        spaceId: objects.spaceId,
      })
      .from(files)
      .innerJoin(objects, eq(objects.id, files.id))
      .innerJoin(fileVersions, eq(fileVersions.id, files.currentVersionId))
      .where(
        and(
          isNotNull(files.currentVersionId),
          sql`${objects.deletedAt} is null`,
          or(eq(files.previewStatus, 'queued'), eq(files.textStatus, 'queued')),
          sql`${files.updatedAt} < now() - interval '1 minute'`,
        ),
      )
      .limit(limit)

    const ctx = systemCtx('files.process-pending')
    for (const row of rows) {
      await db().transaction((tx) =>
        FileProcessing.schedule(tx, ctx, { ...row, versionId: row.versionId as string }),
      )
    }
    return rows.length
  },
}
