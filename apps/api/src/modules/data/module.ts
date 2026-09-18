import {
  DatasetCreateInput,
  DatasetFieldConvertInput,
  DatasetFieldConvertReport,
  DatasetFieldInput,
  DatasetFieldPatch,
  DatasetRecord,
  DatasetUpdateInput,
  DatasetVersion,
  ImportAnalysis,
  ImportAnalyzeInput,
  ImportRecord,
  ImportRunInput,
  type ObjectSummary,
} from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { datasetFields, datasets, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { DatasetService } from './domain/dataset-service.js'
import {
  ImportService,
  LOAD_JOB,
  NORMALIZE_JOB,
  NormalizedReport,
} from './domain/import-service.js'
import { SchemaService } from './domain/schema-service.js'
import { Physical } from './infra/physical.js'

const IdParam = z.object({ id: z.uuid() })
const FieldParams = z.object({ id: z.uuid(), key: z.string().min(1).max(64) })

/** Типы объектов модуля «Данные» (06-analytics-engine.md). */
export function registerDataObjectTypes(): void {
  registerObjectType({
    type: 'dataset',
    labelKey: 'objects.types.dataset',
    icon: 'dataset',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      /** Правка строк в таблице. */
      edit: { minLevel: 'edit' },
      import: { minLevel: 'edit' },
      export: { minLevel: 'view', capability: 'data.export' },
      /** Схема, политики строк и столбцов. */
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    listFields: [
      {
        key: 'rows',
        labelKey: 'data.fields.rows',
        type: 'integer',
        sql: sql`(${objects.meta}->>'rows')::bigint`,
        sortable: true,
      },
    ],
    summary: async (ids) => {
      const rows = await db()
        .select({ id: datasets.id, rows: datasets.rowCount, version: datasets.currentVersion })
        .from(datasets)
        .where(inArray(datasets.id, ids))
      return new Map(
        rows.map((row) => [
          row.id,
          { meta: { rows: row.rows, version: row.version } } as Partial<ObjectSummary>,
        ]),
      )
    },
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          description: datasets.description,
        })
        .from(datasets)
        .innerJoin(objects, eq(objects.id, datasets.id))
        .where(eq(datasets.id, id))
        .limit(1)
      if (!row) return null
      // В поиск идут название, описание и подписи полей — не строки данных
      const fields = await db()
        .select({ label: datasetFields.label, key: datasetFields.key })
        .from(datasetFields)
        .where(eq(datasetFields.datasetId, id))
      return {
        parentId: row.parentId,
        type: 'dataset',
        spaceId: row.spaceId,
        title: row.title,
        body: [row.description ?? '', ...fields.map((field) => `${field.label.ru} ${field.key}`)]
          .join('\n')
          .slice(0, 20_000),
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
    lifecycle: {
      // Окончательное удаление — вместе с физическими таблицами
      onDelete: async (tx, _ctx, object) => Physical.dropTables(tx, object.id),
    },
  })
}

export function registerDataRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/datasets',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать датасет вручную',
    schema: { body: DatasetCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        DatasetService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/datasets/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Датасет: схема, счётчики, версия',
    schema: { params: IdParam, response: { 200: DatasetRecord } },
    handler: async (request) => DatasetService.get(request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/datasets/:id',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Настройки датасета: описание, ключ строки, поля времени и территории',
    schema: { params: IdParam, body: DatasetUpdateInput, response: { 200: DatasetRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/datasets/:id/fields',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить поле',
    schema: { params: IdParam, body: DatasetFieldInput, response: { 200: DatasetRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.addField(tx, request.ctx, request.params.id, request.body),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    method: 'PATCH',
    url: '/datasets/:id/fields/:key',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить описание поля: подпись, семантика, формат, справочник, индекс',
    schema: { params: FieldParams, body: DatasetFieldPatch, response: { 200: DatasetRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.updateField(
          tx,
          request.ctx,
          request.params.id,
          request.params.key,
          request.body,
        ),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/datasets/:id/fields/:key/convert',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Сменить тип поля: пробный прогон с отчётом или применение',
    schema: {
      params: FieldParams,
      body: DatasetFieldConvertInput,
      response: { 200: DatasetFieldConvertReport },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        SchemaService.convertField(
          tx,
          request.ctx,
          request.params.id,
          request.params.key,
          request.body,
        ),
      ),
  })

  route({
    method: 'DELETE',
    url: '/datasets/:id/fields/:key',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить поле вместе с его данными',
    schema: { params: FieldParams, response: { 200: DatasetRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.removeField(tx, request.ctx, request.params.id, request.params.key),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/datasets/:id/versions',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Версии датасета',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(DatasetVersion) }) } },
    handler: async (request) => ({ items: await DatasetService.versions(request.params.id) }),
  })

  route({
    method: 'GET',
    url: '/datasets/:id/imports',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Импорты датасета',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(ImportRecord) }) } },
    handler: async (request) => ({ items: await ImportService.list(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/datasets/imports/analyze',
    auth: 'session',
    tags: ['data'],
    summary: 'Анализ файла для импорта: формат, типы, семантика, предпросмотр',
    schema: { body: ImportAnalyzeInput, response: { 200: ImportAnalysis } },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.body.fileId)
      return ImportService.analyze(request.body)
    },
  })

  route({
    method: 'POST',
    url: '/datasets/imports',
    auth: 'session',
    tags: ['data'],
    summary: 'Запустить импорт файла в новый или существующий датасет',
    schema: { body: ImportRunInput, response: { 200: ImportRecord } },
    handler: async (request) => {
      const { target } = request.body
      await authorize(request.ctx, 'view', request.body.fileId)
      if (target.kind === 'new') {
        await authorize(request.ctx, 'create_child', target.parentId ?? target.spaceId)
      } else {
        await authorize(request.ctx, 'import', target.datasetId)
      }
      return db().transaction((tx) => ImportService.start(tx, request.ctx, request.body))
    },
  })

  route({
    method: 'GET',
    url: '/datasets/imports/:id',
    auth: 'session',
    tags: ['data'],
    summary: 'Состояние импорта',
    schema: { params: IdParam, response: { 200: ImportRecord } },
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      await authorize(request.ctx, 'view', record.datasetId)
      return record
    },
  })

  route({
    method: 'POST',
    url: '/internal/data/imports/:id/normalized',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок сообщает итог нормализации файла импорта (ADR-0046)',
    schema: {
      params: IdParam,
      body: NormalizedReport,
      response: { 200: z.object({ loadJobId: z.uuid().nullable() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      return { loadJobId: await ImportService.acceptNormalized(request.params.id, request.body) }
    },
  })
}

/** Фоновая часть: загрузка импорта воркером и реакция на окончательный сбой заданий. */
export function registerDataBackground(): void {
  registerJobHandler({
    queue: LOAD_JOB.queue,
    name: LOAD_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => ImportService.load(job.data, helpers.progress),
  })

  registerSubscriber({
    name: 'data-import-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (!job) return
      const isImportJob =
        (job.queue === NORMALIZE_JOB.queue && job.name === NORMALIZE_JOB.name) ||
        (job.queue === LOAD_JOB.queue && job.name === LOAD_JOB.name)
      if (!isImportJob) return
      const payload = (await JobService.payload(job.id)) as { importId?: string } | null
      if (!payload?.importId) return
      await ImportService.markFailed(
        payload.importId,
        String(event.payload.error ?? 'Сбой задания'),
      )
    },
  })
}
