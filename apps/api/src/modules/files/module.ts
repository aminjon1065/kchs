import {
  FilePreviews,
  FileProcessedInput,
  FileRecord,
  FileText,
  FileVersion,
  FolderCreateInput,
  FolderRecord,
  type ObjectSummary,
  UploadCompleteInput,
  UploadSessionInput,
} from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { buckets, deleteObject } from '~/kernel/storage/s3.js'
import { db } from '~/shared/db/client.js'
import { files, objects } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { AttachmentsFolder } from './domain/attachments.js'
import { FileService } from './domain/file-service.js'
import { OfficeService } from './domain/office-service.js'
import { FileProcessing } from './domain/processing.js'
import { originalAllowed, watermarkLevel, watermarkLines } from './domain/watermark.js'
import { registerOfficePages, registerOfficeRoutes } from './http/office-routes.js'

const IdParam = z.object({ id: z.uuid() })

export function registerFilesObjectTypes(): void {
  registerObjectType({
    type: 'file',
    labelKey: 'objects.types.file',
    icon: 'file',
    route: (id) => `/files/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      download: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      upload_version: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    listFields: [
      {
        key: 'size',
        labelKey: 'common.labels.size',
        type: 'integer',
        sql: sql`(${objects.meta}->>'size')::bigint`,
        sortable: true,
      },
      {
        key: 'mime',
        labelKey: 'files.fields.format',
        type: 'text',
        sql: sql`${objects.meta}->>'mime'`,
      },
    ],
    summary: async (ids) => {
      const rows = await db()
        .select({ id: files.id, mime: files.mime, size: files.size, version: files.versionNumber })
        .from(files)
        .where(inArray(files.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: { mime: row.mime, size: row.size, version: row.version },
          } as Partial<ObjectSummary>,
        ]),
      )
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          id: files.id,
          name: files.name,
          mime: files.mime,
          spaceId: objects.spaceId,
          ownerId: objects.ownerId,
          parentId: objects.parentId,
          updatedAt: objects.updatedAt,
        })
        .from(files)
        .innerJoin(objects, eq(objects.id, files.id))
        .where(eq(files.id, id))
        .limit(1)
      if (!row) return null
      const text = await FileService.extractedText(id)
      return {
        parentId: row.parentId,
        type: 'file',
        spaceId: row.spaceId,
        title: row.name,
        body: (text ?? '').slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { mime: row.mime },
      }
    },
  })
}

export function registerFilesRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/files/upload-sessions',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать сессию загрузки в хранилище',
    schema: {
      body: UploadSessionInput,
      response: {
        200: z.object({
          uploadId: z.uuid(),
          storageKey: z.string(),
          parts: z.array(
            z.object({ partNumber: z.number().int(), url: z.string(), size: z.number().int() }),
          ),
          partSize: z.number().int(),
          expiresAt: z.string(),
          singlePutUrl: z.string().nullable(),
          fileId: z.uuid(),
          versionId: z.uuid(),
        }),
      },
    },
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      const { attachToObjectId, fileId, folderId, spaceId } = request.body
      if (attachToObjectId && !fileId && !folderId) {
        // Вложение меняет объект, к которому прикрепляется: нужен уровень edit на
        // нём, а файл ляжет в системную папку «Вложения» его пространства
        await authorize(request.ctx, 'edit', attachToObjectId)
        const [row] = await db()
          .select({ spaceId: objects.spaceId })
          .from(objects)
          .where(eq(objects.id, attachToObjectId))
          .limit(1)
        if (row?.spaceId !== spaceId) {
          throw errors.validation('Вложение загружается в пространство объекта', [
            { path: 'spaceId', message: 'mismatch' },
          ])
        }
      } else {
        // Загрузка в пространство требует права на создание в нём или в папке
        await authorize(
          request.ctx,
          fileId ? 'upload_version' : 'create_child',
          fileId ?? folderId ?? spaceId,
        )
        if (attachToObjectId) await authorize(request.ctx, 'edit', attachToObjectId)
      }
      return FileService.createUploadSession(request.ctx, request.body)
    },
  })

  route({
    method: 'POST',
    url: '/files/upload-sessions/:id/complete',
    auth: 'session',
    tags: ['files'],
    summary: 'Завершить загрузку и создать файл',
    schema: { params: IdParam, body: UploadCompleteInput, response: { 200: FileRecord } },
    handler: async (request) =>
      FileService.completeUpload(
        request.ctx,
        request.params.id,
        request.body.parts,
        request.body.note,
      ),
  })

  route({
    method: 'DELETE',
    url: '/files/upload-sessions/:id',
    auth: 'session',
    tags: ['files'],
    summary: 'Отменить загрузку',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await FileService.abortUpload(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/files/:id',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Карточка файла',
    schema: { params: IdParam, response: { 200: FileRecord } },
    handler: async (request) => {
      const file = await FileService.get(request.params.id)
      if (!file) throw errors.notFound('Файл')
      return file
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/versions',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Версии файла',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(FileVersion) }) } },
    handler: async (request) => ({ items: await FileService.versions(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/files/:id/versions/:versionId/restore',
    auth: { action: 'edit' },
    tags: ['files'],
    summary: 'Сделать версию текущей',
    schema: {
      params: z.object({ id: z.uuid(), versionId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        FileService.restoreVersion(tx, request.ctx, request.params.id, request.params.versionId),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/download',
    auth: { action: 'download' },
    tags: ['files'],
    summary: 'Ссылка на скачивание',
    schema: {
      params: IdParam,
      querystring: z.object({
        versionId: z.uuid().optional(),
        inline: z.coerce.boolean().default(false),
      }),
      response: { 200: z.object({ url: z.string(), name: z.string() }) },
    },
    handler: async (request) => {
      // Гриф от «конфиденциально»: исходник — только в режиме администратора,
      // остальным — копия с водяным знаком (ADR-0085)
      const level = await watermarkLevel(request.params.id)
      if (level && !originalAllowed(request.ctx)) {
        throw new AppError(
          'forbidden',
          'Файл с грифом скачивается только копией с водяным знаком',
          403,
          { data: { reason: 'watermark_required', confidentiality: level } },
        )
      }
      const result = await FileService.downloadUrl(
        request.params.id,
        request.query.versionId,
        request.query.inline,
      )
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.fileDownloaded,
        objectId: request.params.id,
        objectType: 'file',
        ...(level ? { severity: 'warning' as const } : {}),
        details: {
          versionId: request.query.versionId ?? null,
          ...(level ? { confidentiality: level, original: true } : {}),
        },
      })
      return result
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/previews',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Превью текущей версии файла',
    schema: { params: IdParam, response: { 200: FilePreviews } },
    handler: async (request) => {
      const previews = await FileProcessing.previews(request.params.id)
      // Просмотрщик рисует водяной знак поверх страниц файла с грифом (ADR-0085)
      const level = await watermarkLevel(request.params.id)
      return level
        ? { ...previews, watermark: { lines: watermarkLines(request.ctx, level) } }
        : previews
    },
  })

  route({
    method: 'GET',
    url: '/files/:id/text',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Извлечённый текст файла',
    schema: { params: IdParam, response: { 200: FileText } },
    handler: async (request) => FileProcessing.text(request.params.id),
  })

  route({
    method: 'POST',
    url: '/internal/files/:id/processed',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок сообщает превью и текст версии файла',
    schema: {
      params: IdParam,
      body: FileProcessedInput,
      response: { 200: z.object({ ok: z.boolean(), stale: z.boolean() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      const { stale } = await FileProcessing.applyResult(request.params.id, request.body)
      return { ok: true, stale }
    },
  })

  route({
    method: 'GET',
    url: '/files/attachments-folder',
    auth: 'session',
    tags: ['files'],
    summary: 'Системная папка «Вложения» пространства (если уже создана)',
    schema: {
      querystring: z.object({ spaceId: z.uuid() }),
      response: { 200: z.object({ id: z.uuid().nullable() }) },
    },
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      await authorize(request.ctx, 'view', request.query.spaceId)
      return { id: await AttachmentsFolder.find(request.query.spaceId) }
    },
  })

  route({
    method: 'POST',
    url: '/folders',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать папку',
    schema: { body: FolderCreateInput, response: { 200: FolderRecord } },
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      return db().transaction((tx) => FileService.createFolder(tx, request.ctx, request.body))
    },
  })

  // Совместное редактирование офисных файлов (ADR-0112)
  registerOfficeRoutes(route)
}

/**
 * Страница офисного редактора: не операция API, а документ для кадра рабочей
 * области, со своей политикой CSP (ADR-0112). Поэтому регистрируется прямо на
 * экземпляре и в спецификацию публичного API не попадает.
 */
export function registerFilesPages(app: FastifyInstance): void {
  registerOfficePages(app)
}

/** Фоновая часть модуля: досылка необработанных файлов и реакция на сбой обработки. */
export function registerFilesBackground(): void {
  registerJobHandler({
    queue: 'maintenance',
    name: 'files.process-pending',
    concurrency: 1,
    handle: async () => ({ scheduled: await FileProcessing.schedulePending(100) }),
  })

  // Сессии редактора, о которых сервер документов больше не сообщает (ADR-0112)
  registerJobHandler({
    queue: 'maintenance',
    name: 'files.close-office-sessions',
    concurrency: 1,
    handle: async () => ({ closed: await OfficeService.closeStale() }),
  })

  // Содержимое уничтоженных файлов (ADR-0086): удаление ключа идемпотентно,
  // повтор задания после сбоя удаляет оставшееся
  registerJobHandler({
    queue: 'maintenance',
    name: 'files.delete-stored',
    concurrency: 1,
    handle: async (job) => {
      const keys = (value: unknown) =>
        Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
      const stored = keys(job.data.files)
      const previews = keys(job.data.previews)
      for (const key of stored) await deleteObject(key, buckets.files())
      for (const key of previews) await deleteObject(key, buckets.previews())
      return { deleted: stored.length + previews.length }
    },
  })

  // Окончательный сбой движка: файл не должен навсегда оставаться «в очереди»
  registerSubscriber({
    name: 'files-processing-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (job?.name !== 'file.process' || !job.objectId) return
      await db()
        .update(files)
        .set({ previewStatus: 'failed', textStatus: 'failed' })
        .where(eq(files.id, job.objectId))
    },
  })
}

export function scheduleFilesJobs(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'files.process-pending',
    pattern: '*/10 * * * *',
    labelKey: 'schedules.jobs.filesProcessPending',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'files.close-office-sessions',
    pattern: '17 * * * *',
    labelKey: 'schedules.jobs.filesCloseOfficeSessions',
  })
}
