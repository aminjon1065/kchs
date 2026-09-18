import type { FileRecord, FolderRecord, UploadSessionInput } from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import {
  abortMultipart,
  completeMultipart,
  headObject,
  initMultipart,
  signedGetUrl,
  signedPutUrl,
  storageKey,
} from '~/kernel/storage/s3.js'
import { UserService } from '~/modules/identity/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  files,
  fileTexts,
  fileVersions,
  objects,
  uploadSessions,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'

const SINGLE_PUT_LIMIT = 8 * 1024 * 1024
const SESSION_TTL_HOURS = 24

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
      const versionId = newId()

      if (session.fileId) {
        // Новая версия существующего файла
        const [existing] = await tx
          .select()
          .from(files)
          .where(eq(files.id, session.fileId))
          .limit(1)
        if (!existing) throw errors.notFound('Файл')

        await tx.insert(fileVersions).values({
          id: versionId,
          fileId: session.fileId,
          number: existing.versionNumber + 1,
          storageKey: session.storageKey,
          size,
          mime: session.mime,
          checksum,
          createdBy: ctx.userId,
          note: note ?? null,
        })
        await tx
          .update(files)
          .set({
            currentVersionId: versionId,
            versionNumber: existing.versionNumber + 1,
            storageKey: session.storageKey,
            size,
            mime: session.mime,
            checksum,
            previewStatus: 'queued',
            textStatus: 'queued',
            updatedAt: sql`now()`,
          })
          .where(eq(files.id, session.fileId))

        await ObjectService.update(
          tx,
          ctx,
          session.fileId,
          { meta: { size, mime: session.mime } },
          { silent: true },
        )
        await publishEvent(tx, ctx, {
          type: 'file.version_added',
          object: {
            id: session.fileId,
            type: 'file',
            spaceId: session.spaceId,
            title: existing.name,
          },
          payload: { versionId, number: existing.versionNumber + 1 },
        })
        return session.fileId
      }

      const object = await ObjectService.create(tx, ctx, {
        type: 'file',
        spaceId: session.spaceId,
        parentId: session.folderId,
        title: session.name,
        icon: 'file',
        meta: { size, mime: session.mime },
      })

      await tx.insert(files).values({
        id: object.id,
        folderId: session.folderId,
        name: session.name,
        mime: session.mime,
        size,
        storageKey: session.storageKey,
        checksum,
        currentVersionId: versionId,
        versionNumber: 1,
        previewStatus: 'queued',
        textStatus: 'queued',
      })
      await tx.insert(fileVersions).values({
        id: versionId,
        fileId: object.id,
        number: 1,
        storageKey: session.storageKey,
        size,
        mime: session.mime,
        checksum,
        createdBy: ctx.userId,
        note: note ?? null,
      })

      await publishEvent(tx, ctx, {
        type: 'file.uploaded',
        object: { id: object.id, type: 'file', spaceId: session.spaceId, title: session.name },
        payload: { name: session.name, size, mime: session.mime },
      })

      if (session.attachToObjectId) {
        await LinkService.link(tx, ctx, session.attachToObjectId, object.id, 'attachment')
      }
      return object.id
    })

    await db()
      .update(uploadSessions)
      .set({ status: 'completed' })
      .where(eq(uploadSessions.id, sessionId))

    const record = await FileService.get(fileId)
    if (!record) throw errors.internal('Файл создан, но не читается')
    return record
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
        updatedAt: sql`now()`,
      })
      .where(eq(files.id, fileId))

    await publishEvent(tx, ctx, {
      type: 'file.version_added',
      object: { id: fileId, type: 'file', title: file.name },
      payload: { versionId: newVersionId, number: file.versionNumber + 1 },
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
