import type { ObjectSummary } from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { recordModuleActivity } from '~/kernel/activity/service.js'
import { registerAuditActions } from '~/kernel/audit/registry.js'
import { audit } from '~/kernel/audit/service.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { jobClosedSubscriber } from '~/kernel/jobs/outcomes.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { buckets, deleteObject } from '~/kernel/storage/s3.js'
import { db } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AttachmentsFolder } from './domain/attachments.js'
import { FILES_AUDIT } from './domain/audit-actions.js'
import { FileService } from './domain/file-service.js'
import { OfficeService } from './domain/office-service.js'
import { FILE_PROCESS_JOB, FileProcessing } from './domain/processing.js'
import { authorizeUploadTarget } from './domain/upload-access.js'
import { originalAllowed, watermarkLevel, watermarkLines } from './domain/watermark.js'
import { registerOfficePages, registerOfficeRoutes } from './http/office-routes.js'
import { files } from './schema.js'

export function registerFilesObjectTypes(): void {
  registerAuditActions('files', FILES_AUDIT)
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
      // Разложить файлы по папкам может редактор: цель проверяется правом create_child
      move: { minLevel: 'edit' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    lifecycle: {
      // Папка файла живёт и в таблице модуля: перенос по дереву её обновляет
      onMove: async (tx, _ctx, object) => {
        await tx.update(files).set({ folderId: object.parentId }).where(eq(files.id, object.id))
      },
      // Переименование в реестре — это имя файла: с ним файл скачивается и ищется
      onUpdate: async (tx, _ctx, object, changed) => {
        if (!changed.includes('title')) return
        await tx
          .update(files)
          .set({ name: object.title, updatedAt: sql`now()` })
          .where(eq(files.id, object.id))
      },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    // Словарь файла для ядра (ADR-0182): вложение обсуждения; текст из файла меняет
    // документ поиска; превью и текст обновляют открытую вкладку
    attachable: true,
    reindexOn: ['file.text_extracted'],
    refreshOn: { 'file.previewed': 'preview', 'file.text_extracted': 'text' },
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
    route: 'POST /files/upload-sessions',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать сессию загрузки в хранилище',
    handler: async (request) => {
      await authorizeUploadTarget(request.ctx, request.body)
      return FileService.createUploadSession(request.ctx, request.body)
    },
  })

  route({
    route: 'POST /files/upload-sessions/:id/complete',
    auth: {
      owned: 'FileService — сессия загрузки только своя, право на цель перепроверяется (ADR-0177)',
    },
    tags: ['files'],
    summary: 'Завершить загрузку и создать файл',
    handler: async (request) =>
      FileService.completeUpload(
        request.ctx,
        request.params.id,
        request.body.parts,
        request.body.note,
      ),
  })

  route({
    route: 'GET /files/upload-sessions/:id',
    auth: {
      owned: 'FileService — сессия загрузки только своя, право на цель перепроверяется (ADR-0177)',
    },
    tags: ['files'],
    summary: 'Продолжить прерванную загрузку: адреса частей и что уже загружено',
    handler: async (request) => FileService.resumeUploadSession(request.ctx, request.params.id),
  })

  route({
    route: 'DELETE /files/upload-sessions/:id',
    auth: {
      owned: 'FileService — сессия загрузки только своя, право на цель перепроверяется (ADR-0177)',
    },
    tags: ['files'],
    summary: 'Отменить загрузку',
    handler: async (request) => {
      await FileService.abortUpload(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'GET /files/:id',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Карточка файла',
    handler: async (request) => {
      const file = await FileService.get(request.params.id)
      if (!file) throw errors.notFound('Файл')
      return file
    },
  })

  route({
    route: 'GET /files/:id/versions',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Версии файла',
    handler: async (request) => ({ items: await FileService.versions(request.params.id) }),
  })

  route({
    route: 'POST /files/:id/versions/:versionId/restore',
    auth: { action: 'edit' },
    tags: ['files'],
    summary: 'Сделать версию текущей',
    handler: async (request) => {
      await db().transaction((tx) =>
        FileService.restoreVersion(
          tx,
          request.ctx,
          request.params.id,
          request.params.versionId,
          request.body?.note,
        ),
      )
      return { ok: true }
    },
  })

  route({
    route: 'GET /files/:id/download',
    auth: { action: 'download' },
    tags: ['files'],
    summary: 'Ссылка на скачивание',
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
        action: FILES_AUDIT.fileDownloaded,
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
    route: 'GET /files/:id/previews',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Превью текущей версии файла',
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
    route: 'GET /files/:id/text',
    auth: { action: 'view' },
    tags: ['files'],
    summary: 'Извлечённый текст файла',
    handler: async (request) => FileProcessing.text(request.params.id),
  })

  route({
    route: 'POST /internal/files/:id/processed',
    auth: { engineJob: { scope: (params) => `file:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок сообщает превью и текст версии файла',
    handler: async (request) => {
      const { stale } = await FileProcessing.applyResult(request.params.id, request.body)
      return { ok: true, stale }
    },
  })

  route({
    route: 'GET /files/attachments-folder',
    auth: 'session',
    tags: ['files'],
    summary: 'Системная папка «Вложения» пространства (если уже создана)',
    handler: async (request) => {
      const { authorize } = await import('~/kernel/access/authorize.js')
      await authorize(request.ctx, 'view', request.query.spaceId)
      return { id: await AttachmentsFolder.find(request.query.spaceId) }
    },
  })

  route({
    route: 'POST /folders',
    auth: 'session',
    tags: ['files'],
    summary: 'Создать папку',
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

  // Брошенные загрузки (ADR-0151): докачка держит сессию открытой сутки, потом части
  // многочастной загрузки отменяются
  registerJobHandler({
    queue: 'maintenance',
    name: 'files.prune-uploads',
    concurrency: 1,
    handle: async () => ({ expired: await FileService.pruneUploadSessions() }),
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

  // Загрузка и новая версия — в ленту активности файла (ADR-0182): свои события
  // модуль записывает сам, как задачи и документы
  registerSubscriber({
    name: 'files-activity',
    types: ['file.uploaded', 'file.version_added'],
    handle: async (event) => {
      const verb = event.type === 'file.uploaded' ? 'uploaded' : 'version_added'
      await recordModuleActivity(event, { verb, key: `activity.file.${verb}` })
    },
  })

  // Окончательный сбой или отмена задания движка: файл не должен навсегда
  // оставаться «в очереди» (ADR-0187)
  registerSubscriber(
    jobClosedSubscriber({
      name: 'files-processing-failed',
      jobs: [FILE_PROCESS_JOB],
      onClosed: async ({ job }) => {
        if (!job.objectId) return
        await db()
          .update(files)
          .set({ previewStatus: 'failed', textStatus: 'failed' })
          .where(eq(files.id, job.objectId))
      },
    }),
  )
}

export function declareFilesSchedules(): void {
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
  declareSchedule({
    queue: 'maintenance',
    name: 'files.prune-uploads',
    pattern: '43 3 * * *',
    labelKey: 'schedules.jobs.filesPruneUploads',
  })
}
