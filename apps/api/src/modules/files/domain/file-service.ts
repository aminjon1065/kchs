import type { FileRecord, FolderRecord, UploadSessionInput } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import {
  abortMultipart,
  completeMultipart,
  copyObject,
  headObject,
  initMultipart,
  signedGetUrl,
  signedPutUrl,
  storageKey,
} from '~/kernel/storage/s3.js'
import { UserService } from '~/modules/identity/public.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  filePreviews,
  files,
  fileTexts,
  fileVersions,
  objects,
  uploadSessions,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { AttachmentsFolder } from './attachments.js'
import { FileProcessing } from './processing.js'

const SINGLE_PUT_LIMIT = 8 * 1024 * 1024
const SESSION_TTL_HOURS = 24

interface NewFileInput {
  fileId?: string
  versionId: string
  spaceId: string
  folderId: string | null
  attachToObjectId?: string | null
  name: string
  mime: string
  size: number
  checksum: string | null
  storageKey: string
  note?: string | null
}

/**
 * Новый файл в транзакции: объект реестра, запись файла и первая версия,
 * событие `file.uploaded` и задание превью и текста (09-files.md §2–3).
 */
async function createFile(tx: Executor, ctx: Ctx, input: NewFileInput): Promise<string> {
  // Вложение без явной папки — в системную папку «Вложения» пространства
  const folderId =
    input.folderId ??
    (input.attachToObjectId ? await AttachmentsFolder.ensure(tx, ctx, input.spaceId) : null)

  const object = await ObjectService.create(tx, ctx, {
    ...(input.fileId ? { id: input.fileId } : {}),
    type: 'file',
    spaceId: input.spaceId,
    parentId: folderId,
    title: input.name,
    icon: 'file',
    meta: { size: input.size, mime: input.mime },
  })

  await tx.insert(files).values({
    id: object.id,
    folderId,
    name: input.name,
    mime: input.mime,
    size: input.size,
    storageKey: input.storageKey,
    checksum: input.checksum,
    currentVersionId: input.versionId,
    versionNumber: 1,
    previewStatus: 'queued',
    textStatus: 'queued',
  })
  await tx.insert(fileVersions).values({
    id: input.versionId,
    fileId: object.id,
    number: 1,
    storageKey: input.storageKey,
    size: input.size,
    mime: input.mime,
    checksum: input.checksum,
    createdBy: actorId(ctx),
    note: input.note ?? null,
  })

  await publishEvent(tx, ctx, {
    type: 'file.uploaded',
    object: { id: object.id, type: 'file', spaceId: input.spaceId, title: input.name },
    payload: { name: input.name, size: input.size, mime: input.mime },
  })
  await FileProcessing.schedule(tx, ctx, {
    fileId: object.id,
    spaceId: input.spaceId,
    versionId: input.versionId,
    storageKey: input.storageKey,
    mime: input.mime,
    name: input.name,
  })

  if (input.attachToObjectId) {
    await LinkService.link(tx, ctx, input.attachToObjectId, object.id, 'attachment')
  }
  return object.id
}

interface NewVersionInput {
  fileId: string
  versionId: string
  spaceId: string | null
  storageKey: string
  size: number
  mime: string
  checksum: string | null
  note?: string | null
}

/**
 * Новая версия существующего файла в транзакции вызывающего: запись версии,
 * текущая версия файла, событие `file.version_added` и задания превью и текста.
 * Одна дорога для загрузки из браузера и для сохранения из офисного редактора
 * (ADR-0112) — активность и уведомления у них одинаковые.
 */
async function appendVersion(
  tx: Executor,
  ctx: Ctx,
  input: NewVersionInput,
): Promise<{ number: number }> {
  const [existing] = await tx
    .select()
    .from(files)
    .where(eq(files.id, input.fileId))
    .limit(1)
    .for('update')
  if (!existing) throw errors.notFound('Файл')
  const number = existing.versionNumber + 1

  await tx.insert(fileVersions).values({
    id: input.versionId,
    fileId: input.fileId,
    number,
    storageKey: input.storageKey,
    size: input.size,
    mime: input.mime,
    checksum: input.checksum,
    createdBy: actorId(ctx),
    note: input.note ?? null,
  })
  await tx
    .update(files)
    .set({
      currentVersionId: input.versionId,
      versionNumber: number,
      storageKey: input.storageKey,
      size: input.size,
      mime: input.mime,
      checksum: input.checksum,
      previewStatus: 'queued',
      textStatus: 'queued',
      updatedAt: sql`now()`,
    })
    .where(eq(files.id, input.fileId))

  await ObjectService.update(
    tx,
    ctx,
    input.fileId,
    { meta: { size: input.size, mime: input.mime } },
    { silent: true },
  )
  await publishEvent(tx, ctx, {
    type: 'file.version_added',
    object: {
      id: input.fileId,
      type: 'file',
      spaceId: input.spaceId,
      title: existing.name,
    },
    payload: { versionId: input.versionId, number },
  })
  await FileProcessing.schedule(tx, ctx, {
    fileId: input.fileId,
    spaceId: input.spaceId,
    versionId: input.versionId,
    storageKey: input.storageKey,
    mime: input.mime,
    name: existing.name,
  })
  return { number }
}

export const FileService = {
  /** Шаг 1: клиент получает подписанные URL и грузит прямо в S3 (09-files.md §2). */
  async createUploadSession(ctx: UserCtx, input: UploadSessionInput) {
    const fileId = input.fileId ?? newId()
    const versionId = newId()
    const key = storageKey(input.spaceId, fileId, versionId, input.name)

    const single = input.size <= SINGLE_PUT_LIMIT
    const multipart = single ? null : await initMultipart(key, input.size, input.mime)

    const sessionId = newId()
    await db()
      .insert(uploadSessions)
      .values({
        id: sessionId,
        userId: ctx.userId,
        spaceId: input.spaceId,
        folderId: input.folderId ?? null,
        fileId: input.fileId ?? null,
        plannedFileId: fileId,
        plannedVersionId: versionId,
        attachToObjectId: input.attachToObjectId ?? null,
        name: input.name,
        mime: input.mime,
        size: input.size,
        storageKey: key,
        multipartUploadId: multipart?.uploadId ?? null,
        parts: [],
        expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000).toISOString(),
      })

    return {
      uploadId: sessionId,
      storageKey: key,
      parts: multipart?.partUrls ?? [],
      partSize: multipart?.partSize ?? input.size,
      expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000).toISOString(),
      singlePutUrl: single ? await signedPutUrl(key, { contentType: input.mime }) : null,
      fileId,
      versionId,
    }
  },

  /** Шаг 2: подтверждение загрузки создаёт объект реестра и версию файла. */
  async completeUpload(
    ctx: UserCtx,
    sessionId: string,
    parts: Array<{ partNumber: number; etag: string }>,
    note?: string,
  ): Promise<FileRecord> {
    const [session] = await db()
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.userId, ctx.userId)))
      .limit(1)
    if (!session) throw errors.notFound('Сессия загрузки')
    if (session.status !== 'open') throw errors.conflict('Сессия загрузки уже завершена')

    if (session.multipartUploadId) {
      await completeMultipart(session.storageKey, session.multipartUploadId, parts)
    }

    const head = await headObject(session.storageKey).catch(() => null)
    if (!head) throw errors.dependencyFailed('Файл не найден в хранилище')

    const size = head.ContentLength ?? session.size
    const checksum = head.ETag?.replace(/"/g, '') ?? null

    const fileId = await db().transaction(async (tx) => {
      // Те же идентификаторы, что в ключе хранения: путь в S3 указывает на объект и версию
      const versionId = session.plannedVersionId ?? newId()

      if (session.fileId) {
        // Новая версия существующего файла
        await appendVersion(tx, ctx, {
          fileId: session.fileId,
          versionId,
          spaceId: session.spaceId,
          storageKey: session.storageKey,
          size,
          mime: session.mime,
          checksum,
          note: note ?? null,
        })
        return session.fileId
      }

      return createFile(tx, ctx, {
        ...(session.plannedFileId ? { fileId: session.plannedFileId } : {}),
        versionId,
        spaceId: session.spaceId,
        folderId: session.folderId,
        attachToObjectId: session.attachToObjectId,
        name: session.name,
        mime: session.mime,
        size,
        checksum,
        storageKey: session.storageKey,
        note: note ?? null,
      })
    })

    await db()
      .update(uploadSessions)
      .set({ status: 'completed' })
      .where(eq(uploadSessions.id, sessionId))

    const record = await FileService.get(fileId)
    if (!record) throw errors.internal('Файл создан, но не читается')
    return record
  },

  /**
   * Файл из объекта, который уже лежит в хранилище (демо-данные сида, ADR-0063):
   * серверная копия под ключом файла пространства, дальше — как подтверждённая
   * загрузка (объект реестра, версия, событие, превью).
   */
  async registerStored(
    ctx: Ctx,
    input: {
      spaceId: string
      folderId?: string | null
      /** Вложение объекта (скан демо-документа): права — от объекта-хоста. */
      attachToObjectId?: string | null
      name: string
      mime: string
      sourceKey: string
    },
  ): Promise<FileRecord> {
    const fileId = newId()
    const versionId = newId()
    const key = storageKey(input.spaceId, fileId, versionId, input.name)
    await copyObject(input.sourceKey, key)
    const head = await headObject(key)
    await db().transaction((tx) =>
      createFile(tx, ctx, {
        fileId,
        versionId,
        spaceId: input.spaceId,
        folderId: input.folderId ?? null,
        attachToObjectId: input.attachToObjectId ?? null,
        name: input.name,
        mime: input.mime,
        size: head.ContentLength ?? 0,
        checksum: head.ETag?.replace(/"/g, '') ?? null,
        storageKey: key,
      }),
    )
    const record = await FileService.get(fileId)
    if (!record) throw errors.internal('Файл создан, но не читается')
    return record
  },

  /**
   * Файл, который другой модуль уже положил в хранилище под ключом этого файла
   * (PDF-представление версии документа от движка): объект реестра, версия,
   * превью и, при необходимости, связь-вложение — в транзакции вызывающего.
   */
  async registerGenerated(
    tx: Executor,
    ctx: Ctx,
    input: {
      fileId: string
      versionId: string
      spaceId: string
      name: string
      mime: string
      size: number
      storageKey: string
      checksum: string | null
      attachToObjectId?: string | null
    },
  ): Promise<string> {
    return createFile(tx, ctx, {
      fileId: input.fileId,
      versionId: input.versionId,
      spaceId: input.spaceId,
      folderId: null,
      attachToObjectId: input.attachToObjectId ?? null,
      name: input.name,
      mime: input.mime,
      size: input.size,
      checksum: input.checksum,
      storageKey: input.storageKey,
    })
  },

  /**
   * Новая версия файла, содержимое которой уже лежит в хранилище под ключом
   * этой версии: сохранение из офисного редактора (ADR-0112). Дальше всё как у
   * обычной загрузки — событие, активность, уведомления, превью и текст.
   * Права проверяет вызывающий.
   */
  async addStoredVersion(
    tx: Executor,
    ctx: Ctx,
    input: {
      fileId: string
      versionId: string
      spaceId: string | null
      storageKey: string
      size: number
      mime: string
      checksum?: string | null
      note?: string | null
    },
  ): Promise<{ number: number }> {
    return appendVersion(tx, ctx, { ...input, checksum: input.checksum ?? null })
  },

  /**
   * Уничтожение файлов вместе с содержимым (акт о выделении к уничтожению,
   * ADR-0086): объекты реестра удаляются окончательно в транзакции вызывающего
   * (версии, превью, текст, ссылки — каскадом), а байты всех версий и превью
   * удаляет из хранилища задание, поставленное в той же транзакции: откат
   * ничего не удалит, а сбой после коммита не оставит содержимое навсегда.
   */
  async destroy(tx: Executor, ctx: Ctx, fileIds: string[]): Promise<number> {
    const ids = [...new Set(fileIds)]
    if (ids.length === 0) return 0
    const present = await tx
      .select({ id: files.id, storageKey: files.storageKey })
      .from(files)
      .where(inArray(files.id, ids))
    if (present.length === 0) return 0
    const found = present.map((row) => row.id)
    const [versions, previews] = await Promise.all([
      tx
        .select({ storageKey: fileVersions.storageKey })
        .from(fileVersions)
        .where(inArray(fileVersions.fileId, found)),
      tx
        .select({ storageKey: filePreviews.storageKey })
        .from(filePreviews)
        .where(inArray(filePreviews.fileId, found)),
    ])
    const stored = [
      ...new Set([
        ...present.map((row) => row.storageKey),
        ...versions.map((row) => row.storageKey),
      ]),
    ]
    for (const id of found) await ObjectService.purge(tx, ctx, id)
    await JobService.schedule(tx, ctx, {
      queue: 'maintenance',
      name: 'files.delete-stored',
      data: { files: stored, previews: [...new Set(previews.map((row) => row.storageKey))] },
    })
    return found.length
  },

  /** Краткие сведения о файлах для карточек других модулей: имя, тип, размер, сумма. */
  async briefs(
    fileIds: string[],
    database: Executor = db(),
  ): Promise<
    Map<
      string,
      {
        id: string
        name: string
        mime: string
        size: number
        checksum: string | null
        currentVersionId: string | null
        storageKey: string
      }
    >
  > {
    if (fileIds.length === 0) return new Map()
    const rows = await database
      .select({
        id: files.id,
        name: files.name,
        mime: files.mime,
        size: files.size,
        checksum: files.checksum,
        currentVersionId: files.currentVersionId,
        storageKey: files.storageKey,
      })
      .from(files)
      .where(inArray(files.id, fileIds))
    return new Map(rows.map((row) => [row.id, row]))
  },

  async abortUpload(ctx: UserCtx, sessionId: string): Promise<void> {
    const [session] = await db()
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.id, sessionId), eq(uploadSessions.userId, ctx.userId)))
      .limit(1)
    if (!session) return
    if (session.multipartUploadId) {
      await abortMultipart(session.storageKey, session.multipartUploadId)
    }
    await db()
      .update(uploadSessions)
      .set({ status: 'aborted' })
      .where(eq(uploadSessions.id, sessionId))
  },

  async get(fileId: string, database: Database = db()): Promise<FileRecord | null> {
    const [row] = await database
      .select({
        id: files.id,
        name: files.name,
        mime: files.mime,
        size: files.size,
        folderId: files.folderId,
        checksum: files.checksum,
        currentVersionId: files.currentVersionId,
        versionNumber: files.versionNumber,
        previewStatus: files.previewStatus,
        textStatus: files.textStatus,
        lockedBy: files.lockedBy,
        lockedAt: files.lockedAt,
        createdAt: files.createdAt,
        updatedAt: files.updatedAt,
        spaceId: objects.spaceId,
        ownerId: objects.ownerId,
      })
      .from(files)
      .innerJoin(objects, eq(objects.id, files.id))
      .where(eq(files.id, fileId))
      .limit(1)

    if (!row) return null
    const refs = await UserService.refs(
      [row.ownerId, row.lockedBy].filter((v): v is string => Boolean(v)),
      database,
    )

    return {
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      spaceId: row.spaceId ?? '',
      folderId: row.folderId,
      checksum: row.checksum,
      currentVersionId: row.currentVersionId,
      versionNumber: row.versionNumber,
      previewStatus: row.previewStatus as FileRecord['previewStatus'],
      textStatus: row.textStatus as FileRecord['textStatus'],
      lockedBy: row.lockedBy ? (refs.get(row.lockedBy) ?? null) : null,
      lockedAt: row.lockedAt,
      owner: row.ownerId ? (refs.get(row.ownerId) ?? null) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  },

  async versions(fileId: string) {
    const rows = await db()
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId))
      .orderBy(sql`${fileVersions.number} desc`)
    const refs = await UserService.refs(
      rows.map((r) => r.createdBy).filter((v): v is string => Boolean(v)),
    )
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      size: row.size,
      checksum: row.checksum ?? '',
      createdBy: row.createdBy ? (refs.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt,
      note: row.note,
    }))
  },

  async downloadUrl(
    fileId: string,
    versionId?: string,
    inline = false,
  ): Promise<{ url: string; name: string }> {
    const [file] = await db().select().from(files).where(eq(files.id, fileId)).limit(1)
    if (!file) throw errors.notFound('Файл')

    let key = file.storageKey
    if (versionId) {
      const [version] = await db()
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.id, versionId)))
        .limit(1)
      if (!version) throw errors.notFound('Версия файла')
      key = version.storageKey
    }
    return { url: await signedGetUrl(key, { filename: file.name, inline }), name: file.name }
  },

  /** Восстановление старой версии создаёт новую (09-files.md §2). */
  async restoreVersion(
    tx: Executor,
    ctx: UserCtx,
    fileId: string,
    versionId: string,
  ): Promise<void> {
    const [file] = await tx.select().from(files).where(eq(files.id, fileId)).limit(1)
    const [version] = await tx
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.id, versionId)))
      .limit(1)
    if (!file || !version) throw errors.notFound('Версия файла')

    const newVersionId = newId()
    await tx.insert(fileVersions).values({
      id: newVersionId,
      fileId,
      number: file.versionNumber + 1,
      storageKey: version.storageKey,
      size: version.size,
      mime: version.mime,
      checksum: version.checksum,
      createdBy: ctx.userId,
      note: `Восстановлена версия ${version.number}`,
    })
    await tx
      .update(files)
      .set({
        currentVersionId: newVersionId,
        versionNumber: file.versionNumber + 1,
        storageKey: version.storageKey,
        size: version.size,
        mime: version.mime,
        checksum: version.checksum,
        previewStatus: 'queued',
        textStatus: 'queued',
        updatedAt: sql`now()`,
      })
      .where(eq(files.id, fileId))

    await publishEvent(tx, ctx, {
      type: 'file.version_added',
      object: { id: fileId, type: 'file', title: file.name },
      payload: { versionId: newVersionId, number: file.versionNumber + 1 },
    })
    const [object] = await tx
      .select({ spaceId: objects.spaceId })
      .from(objects)
      .where(eq(objects.id, fileId))
      .limit(1)
    await FileProcessing.schedule(tx, ctx, {
      fileId,
      spaceId: object?.spaceId ?? null,
      versionId: newVersionId,
      storageKey: version.storageKey,
      mime: version.mime,
      name: file.name,
    })
  },

  async createFolder(
    tx: Executor,
    ctx: Ctx,
    input: { name: string; spaceId: string; parentId?: string | null },
  ): Promise<FolderRecord> {
    const object = await ObjectService.create(tx, ctx, {
      type: 'folder',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      icon: 'folder',
    })
    return {
      id: object.id,
      name: input.name,
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      childCount: 0,
      system: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  },

  async extractedText(fileId: string): Promise<string | null> {
    const [row] = await db()
      .select({ text: fileTexts.text })
      .from(fileTexts)
      .where(eq(fileTexts.fileId, fileId))
      .limit(1)
    return row?.text ?? null
  },
}
