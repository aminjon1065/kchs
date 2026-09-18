import {
  ChartCreateInput,
  ChartDataInput,
  ChartRecord,
  ChartUpdateInput,
  DashboardCreateInput,
  DashboardData,
  DashboardDataInput,
  DashboardRecord,
  DashboardUpdateInput,
  DatasetColumnPolicy,
  DatasetColumnPolicyInput,
  DatasetColumnPolicyPatch,
  DatasetCreateInput,
  DatasetExportDownload,
  DatasetExportInput,
  DatasetExportStarted,
  DatasetFieldConvertInput,
  DatasetFieldConvertReport,
  DatasetFieldInput,
  DatasetFieldPatch,
  DatasetPolicies,
  DatasetRecord,
  DatasetRow,
  DatasetRowHistoryEntry,
  DatasetRowPatch,
  DatasetRowPolicy,
  DatasetRowPolicyInput,
  DatasetRowPolicyPatch,
  DatasetRowsDelete,
  DatasetRowsInsert,
  DatasetRowsQuery,
  DatasetUpdateInput,
  DatasetVersion,
  FieldProfile,
  ImportAnalysis,
  ImportAnalyzeInput,
  ImportRecord,
  ImportRunInput,
  type ObjectSummary,
  QueryResult,
  QueryRunInput,
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
import { ChartService, runChartSpec } from './domain/chart-service.js'
import { DashboardService } from './domain/dashboard-service.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { EXPORT_JOB, type ExportJobData, ExportService } from './domain/export-service.js'
import {
  ImportService,
  LOAD_JOB,
  NORMALIZE_JOB,
  NormalizedReport,
} from './domain/import-service.js'
import { PolicyService } from './domain/policy-service.js'
import { ProfileService } from './domain/profile-service.js'
import { QueryService } from './domain/query-service.js'
import { RowService } from './domain/row-service.js'
import { SchemaService } from './domain/schema-service.js'
import { Physical } from './infra/physical.js'

const IdParam = z.object({ id: z.uuid() })
const FieldParams = z.object({ id: z.uuid(), key: z.string().min(1).max(64) })
const RowParams = z.object({ id: z.uuid(), rowId: z.string().regex(/^\d{1,18}$/) })
const PolicyParams = z.object({ id: z.uuid(), policyId: z.uuid() })

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

  // График и дашборд: права на объект не открывают данные — данные плиток и
  // графиков считаются с политиками смотрящего (03-access-model.md)
  for (const type of ['chart', 'dashboard'] as const) {
    registerObjectType({
      type,
      labelKey: `objects.types.${type}`,
      icon: type,
      route: (id) => `/o/${id}`,
      levels: ['view', 'comment', 'edit', 'manage', 'owner'],
      actions: {
        view: { minLevel: 'view' },
        comment: { minLevel: 'comment' },
        edit: { minLevel: 'edit' },
        manage: { minLevel: 'manage' },
        share: { minLevel: 'manage' },
        delete: { minLevel: 'manage' },
      },
      discussable: true,
      linkable: true,
      hasParentTree: true,
      searchable: async (id) => {
        const [row] = await db()
          .select({
            title: objects.title,
            subtitle: objects.subtitle,
            spaceId: objects.spaceId,
            parentId: objects.parentId,
            ownerId: objects.ownerId,
            updatedAt: objects.updatedAt,
          })
          .from(objects)
          .where(eq(objects.id, id))
          .limit(1)
        if (!row) return null
        return {
          parentId: row.parentId,
          type,
          spaceId: row.spaceId,
          title: row.title,
          body: row.subtitle ?? '',
          ownerId: row.ownerId,
          updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
          meta: {},
        }
      },
    })
  }
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
    auth: 'session',
    tags: ['data'],
    summary: 'Датасет: схема, счётчики, версия',
    schema: { params: IdParam, response: { 200: DatasetRecord } },
    handler: async (request) => {
      const grant = await DatasetAccess.resolve(request.ctx, request.params.id)
      const record = await DatasetService.get(request.params.id)
      if (grant.hidden.size === 0) return record
      // Скрытые политикой поля не видны и в схеме — вместе с ролями ключа и времени
      const visible = (key: string | null) => (key && !grant.hidden.has(key) ? key : null)
      return {
        ...record,
        fields: record.fields.filter((field) => !grant.hidden.has(field.key)),
        primaryKey: record.primaryKey.filter((key) => !grant.hidden.has(key)),
        timeField: visible(record.timeField),
        territoryField: visible(record.territoryField),
      }
    },
  })

  route({
    method: 'GET',
    url: '/datasets/:id/fields/:key/profile',
    auth: 'session',
    tags: ['data'],
    summary: 'Профиль столбца: пустые, различные, диапазон, распределение, частые значения',
    schema: { params: FieldParams, response: { 200: FieldProfile } },
    handler: async (request) => {
      const grant = await DatasetAccess.resolve(request.ctx, request.params.id)
      const [storage, record] = await Promise.all([
        DatasetService.storage(request.params.id),
        DatasetService.get(request.params.id),
      ])
      return ProfileService.field(grant, storage, record, request.params.key)
    },
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
    method: 'POST',
    url: '/datasets/:id/exports',
    auth: 'session',
    tags: ['data'],
    summary: 'Экспорт датасета в CSV, XLSX, JSON или GeoJSON — задание с файлом',
    schema: {
      params: IdParam,
      body: DatasetExportInput,
      response: { 200: DatasetExportStarted },
    },
    handler: async (request) => ExportService.start(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'GET',
    url: '/datasets/exports/:jobId/download',
    auth: 'session',
    tags: ['data'],
    summary: 'Ссылка на файл экспорта — только запросившему',
    schema: {
      params: z.object({ jobId: z.uuid() }),
      response: { 200: DatasetExportDownload },
    },
    handler: async (request) => ExportService.download(request.ctx, request.params.jobId),
  })

  route({
    method: 'GET',
    url: '/datasets/:id/policies',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Политики строк и столбцов датасета',
    schema: { params: IdParam, response: { 200: DatasetPolicies } },
    handler: async (request) => PolicyService.list(request.params.id),
  })

  route({
    method: 'POST',
    url: '/datasets/:id/policies/rows',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику строк: кому и какие строки видны',
    schema: { params: IdParam, body: DatasetRowPolicyInput, response: { 200: DatasetRowPolicy } },
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createRow(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    method: 'PATCH',
    url: '/datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику строк',
    schema: {
      params: PolicyParams,
      body: DatasetRowPolicyPatch,
      response: { 200: DatasetRowPolicy },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.updateRow(
          tx,
          request.ctx,
          request.params.id,
          request.params.policyId,
          request.body,
        ),
      ),
  })

  route({
    method: 'DELETE',
    url: '/datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику строк',
    schema: { params: PolicyParams, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeRow(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/datasets/:id/policies/columns',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику столбцов: скрыть или замаскировать поля',
    schema: {
      params: IdParam,
      body: DatasetColumnPolicyInput,
      response: { 200: DatasetColumnPolicy },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createColumn(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    method: 'PATCH',
    url: '/datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику столбцов',
    schema: {
      params: PolicyParams,
      body: DatasetColumnPolicyPatch,
      response: { 200: DatasetColumnPolicy },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.updateColumn(
          tx,
          request.ctx,
          request.params.id,
          request.params.policyId,
          request.body,
        ),
      ),
  })

  route({
    method: 'DELETE',
    url: '/datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику столбцов',
    schema: { params: PolicyParams, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeColumn(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/queries/run',
    auth: 'session',
    tags: ['data'],
    summary: 'Выполнить QuerySpec: источники с политиками пользователя, результат столбцами',
    schema: { body: QueryRunInput, response: { 200: QueryResult } },
    handler: async (request) =>
      QueryService.run(request.ctx, request.body.spec, { params: request.body.params }),
  })

  route({
    method: 'POST',
    url: '/datasets/:id/rows/query',
    auth: 'session',
    tags: ['data'],
    summary: 'Страница строк таблицы датасета: фильтр, поиск, сортировка, счётчик',
    schema: { params: IdParam, body: DatasetRowsQuery, response: { 200: QueryResult } },
    handler: async (request) => RowService.query(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/datasets/:id/rows',
    auth: 'session',
    tags: ['data'],
    summary: 'Добавить строки (до 1000)',
    schema: {
      params: IdParam,
      body: DatasetRowsInsert,
      response: { 200: z.object({ items: z.array(DatasetRow) }) },
    },
    handler: async (request) => ({
      items: await RowService.insert(request.ctx, request.params.id, request.body.rows),
    }),
  })

  route({
    method: 'POST',
    url: '/datasets/:id/rows/delete',
    auth: 'session',
    tags: ['data'],
    summary: 'Удалить строки (до 1000)',
    schema: {
      params: IdParam,
      body: DatasetRowsDelete,
      response: { 200: z.object({ deleted: z.number().int() }) },
    },
    handler: async (request) => ({
      deleted: await RowService.remove(request.ctx, request.params.id, request.body.ids),
    }),
  })

  route({
    method: 'GET',
    url: '/datasets/:id/rows/:rowId',
    auth: 'session',
    tags: ['data'],
    summary: 'Строка датасета',
    schema: { params: RowParams, response: { 200: DatasetRow } },
    handler: async (request) =>
      RowService.get(request.ctx, request.params.id, request.params.rowId),
  })

  route({
    method: 'PATCH',
    url: '/datasets/:id/rows/:rowId',
    auth: 'session',
    tags: ['data'],
    summary: 'Изменить строку; конфликт версии — 409 с текущими значениями',
    schema: { params: RowParams, body: DatasetRowPatch, response: { 200: DatasetRow } },
    handler: async (request) =>
      RowService.update(request.ctx, request.params.id, request.params.rowId, request.body),
  })

  route({
    method: 'GET',
    url: '/datasets/:id/rows/:rowId/history',
    auth: 'session',
    tags: ['data'],
    summary: 'История изменений строки',
    schema: {
      params: RowParams,
      response: { 200: z.object({ items: z.array(DatasetRowHistoryEntry) }) },
    },
    handler: async (request) => ({
      items: await RowService.history(request.ctx, request.params.id, request.params.rowId),
    }),
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
    url: '/charts',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать график',
    schema: { body: ChartCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => ChartService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/charts/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'График: спецификация',
    schema: { params: IdParam, response: { 200: ChartRecord } },
    handler: async (request) => ChartService.get(request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/charts/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить график: название, спецификация',
    schema: { params: IdParam, body: ChartUpdateInput, response: { 200: ChartRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ChartService.update(tx, request.ctx, request.params.id, request.body),
      )
      return ChartService.get(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/charts/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные графика — с политиками пользователя',
    schema: { params: IdParam, body: ChartDataInput, response: { 200: QueryResult } },
    handler: async (request) => {
      const chart = await ChartService.get(request.params.id)
      return runChartSpec(request.ctx, chart.spec, {
        ...chart.paramsDefaults,
        ...request.body.params,
      })
    },
  })

  route({
    method: 'POST',
    url: '/dashboards',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать дашборд',
    schema: { body: DashboardCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        DashboardService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/dashboards/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Дашборд: плитки и фильтры',
    schema: { params: IdParam, response: { 200: DashboardRecord } },
    handler: async (request) => DashboardService.get(request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/dashboards/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить дашборд: название, плитки, фильтры',
    schema: { params: IdParam, body: DashboardUpdateInput, response: { 200: DashboardRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DashboardService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DashboardService.get(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/dashboards/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные плиток дашборда одним запросом, с фильтрами дашборда',
    schema: { params: IdParam, body: DashboardDataInput, response: { 200: DashboardData } },
    handler: async (request) => DashboardService.data(request.ctx, request.params.id, request.body),
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

  registerJobHandler({
    queue: EXPORT_JOB.queue,
    name: EXPORT_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => ExportService.run(job.data as ExportJobData, helpers),
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
