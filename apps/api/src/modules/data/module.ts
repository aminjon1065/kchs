import {
  ColumnarBuildJob,
  ColumnarBuildJobResult,
  type DatasetRowsBatch,
  type ObjectSummary,
  QUALITY_STATUSES,
} from '@kchs/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { authorize } from '~/kernel/access/authorize.js'
import { registerAuditActions } from '~/kernel/audit/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { closedReason, jobClosedSubscriber } from '~/kernel/jobs/outcomes.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerNotificationCategory } from '~/kernel/notifications/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { logger } from '~/shared/logger/index.js'
import {
  registerAnalysisBackground,
  registerAnalysisObjectType,
  registerAnalysisRoutes,
} from './analysis-module.js'
import { AskService } from './domain/ask-service.js'
import { DATA_AUDIT } from './domain/audit-actions.js'
import { ChartService, runChartSpec } from './domain/chart-service.js'
import { COLUMNAR_BUILD_JOB, ColumnarService } from './domain/columnar-service.js'
import { DashboardService } from './domain/dashboard-service.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { EXPORT_JOB, type ExportJobData, ExportService } from './domain/export-service.js'
import { HistoryRetention } from './domain/history-retention.js'
import { COMPARE_JOB, ImportService, LOAD_JOB, NORMALIZE_JOB } from './domain/import-service.js'
import { MetricService } from './domain/metric-service.js'
import { PolicyService } from './domain/policy-service.js'
import { ProfileService } from './domain/profile-service.js'
import { QualityService } from './domain/quality-service.js'
import { QueryService } from './domain/query-service.js'
import { RollbackService } from './domain/rollback-service.js'
import { RowService } from './domain/row-service.js'
import {
  applyRowsBatch,
  BATCH_INLINE_LIMIT,
  batchSize,
  queueRowsBatch,
  ROWS_BATCH_JOB,
  runQueuedRowsBatch,
} from './domain/rows-batch.js'
import { SchemaService } from './domain/schema-service.js'
import { SqlService } from './domain/sql-service.js'
import { systemDatasetSchema } from './domain/system-schema.js'
import { registerExportRoutes } from './export-module.js'
import { Physical } from './infra/physical.js'
import {
  registerNotebookBackground,
  registerNotebookRoutes,
  registerNotebookType,
} from './notebook-module.js'
import {
  declarePipelineSchedules,
  registerPipelineBackground,
  registerPipelineObjectType,
  registerPipelineRoutes,
  schedulePipelineJobs,
} from './pipeline-module.js'
import { datasetFields, datasetQualityRuns, datasets } from './schema.js'
import {
  declareSourceSchedules,
  registerSourceBackground,
  registerSourceObjectType,
  registerSourceRoutes,
  scheduleSourceJobs,
} from './source-module.js'

/** Таблицы датасетов, созданные прежними версиями, — к текущему виду (при старте). */
export async function upgradeDataStorage(): Promise<void> {
  const upgraded = await Physical.upgradeHistoryTables()
  if (upgraded > 0) logger().info({ upgraded }, 'таблицы истории строк дополнены номером версии')
  const keys = await Physical.upgradeKeyIndexes()
  if (keys > 0) logger().info({ keys }, 'индексы ключа строк — только по живым строкам (ADR-0160)')
}

/** Последняя проверка качества датасета — подзапросом поля списка (ADR-0101). */
const qualityRun = alias(datasetQualityRuns, 'quality_run')

/** Типы объектов модуля «Данные» (06-analytics-engine.md). */
export function registerDataObjectTypes(): void {
  registerNotificationCategory('data', { app: 'immediate', email: 'digest' })
  registerAuditActions('data', DATA_AUDIT)
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
    // Подписи полей входят в документ поиска, а правка схемы публикует только своё
    // событие (ADR-0170, ADR-0182)
    reindexOn: ['dataset.schema_changed'],
    listFields: [
      {
        key: 'rows',
        labelKey: 'data.fields.rows',
        type: 'integer',
        sql: sql`(${objects.meta}->>'rows')::bigint`,
        sortable: true,
      },
      // Бейдж качества в каталоге (ADR-0101): последняя проверка датасета
      {
        key: 'quality',
        labelKey: 'data.quality.title',
        type: 'select',
        sql: sql`(select ${qualityRun.status} from ${qualityRun}
          where ${qualityRun.datasetId} = ${objects.id}
          order by ${qualityRun.checkedAt} desc limit 1)`,
        sortable: true,
        options: QUALITY_STATUSES.filter((value) => value !== 'unknown').map((value) => ({
          value,
          labelKey: `data.quality.statuses.${value}`,
        })),
      },
    ],
    summary: async (ids) => {
      const [rows, quality] = await Promise.all([
        db()
          .select({ id: datasets.id, rows: datasets.rowCount, version: datasets.currentVersion })
          .from(datasets)
          .where(inArray(datasets.id, ids)),
        // Бейдж качества в каталоге и карточке (ADR-0101)
        QualityService.statuses(ids),
      ])
      return new Map(
        rows.map((row) => [
          row.id,
          {
            meta: {
              rows: row.rows,
              version: row.version,
              quality: quality.get(row.id) ?? 'unknown',
            },
          } as Partial<ObjectSummary>,
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

  // График, дашборд и показатель: права на объект не открывают данные — данные
  // плиток, графиков и значения показателей считаются с политиками смотрящего
  // (03-access-model.md)
  for (const type of ['chart', 'dashboard', 'metric'] as const) {
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

  registerAnalysisObjectType()
  registerNotebookType()
  registerPipelineObjectType()
  registerSourceObjectType()
}

export function registerDataRoutes(route: RouteRegistrar): void {
  registerAnalysisRoutes(route)
  registerExportRoutes(route)
  registerNotebookRoutes(route)
  registerPipelineRoutes(route)
  registerSourceRoutes(route)

  route({
    route: 'POST /datasets',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать датасет вручную',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        DatasetService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /datasets/:id/quality',
    auth: { delegated: 'QualityService.get', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Качество данных: правила и последняя проверка (ADR-0101)',
    handler: async (request) => QualityService.get(request.ctx, request.params.id),
  })

  route({
    route: 'GET /datasets/:id/columnar',
    auth: { delegated: 'ColumnarService.state', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Колоночная копия датасета: версия, размер, время сборки, свежесть (ADR-0109)',
    handler: async (request) => ColumnarService.state(request.ctx, request.params.id),
  })

  route({
    route: 'POST /datasets/:id/columnar/build',
    auth: { delegated: 'ColumnarService.build', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Собрать колоночную копию текущей версии (уровень manage)',
    handler: async (request) => ColumnarService.build(request.ctx, request.params.id),
  })

  route({
    route: 'GET /admin/data/columnar',
    auth: { capability: 'admin.system' },
    tags: ['data'],
    summary: 'Колоночный tier: настройки и копии датасетов (ADR-0109)',
    handler: async (request) => ColumnarService.admin(request.ctx),
  })

  route({
    route: 'PUT /admin/data/columnar/settings',
    auth: { capability: 'admin.system' },
    tags: ['data'],
    summary: 'Настройки колоночного tier: включён и порог строк',
    handler: async (request) => ColumnarService.updateSettings(request.ctx, request.body),
  })

  route({
    route: 'PUT /datasets/:id/quality/rules',
    auth: { delegated: 'QualityService.setRules', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Правила качества датасета: замена набора (уровень manage)',
    handler: async (request) => {
      await QualityService.setRules(request.ctx, request.params.id, request.body.rules)
      return QualityService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /datasets/:id/quality/run',
    auth: { delegated: 'QualityService.run', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Проверить качество сейчас',
    handler: async (request) => QualityService.run(request.ctx, request.params.id),
  })

  route({
    route: 'GET /datasets/:id',
    auth: { delegated: 'DatasetAccess.resolve', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Датасет: схема, счётчики, версия',
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
    route: 'GET /datasets/:id/fields/:key/profile',
    auth: { delegated: 'DatasetAccess.resolve', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Профиль столбца: пустые, различные, диапазон, распределение, частые значения',
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
    route: 'PATCH /datasets/:id',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Настройки датасета: описание, ключ строки, поля времени и территории',
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    route: 'POST /datasets/:id/fields',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить поле',
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.addField(tx, request.ctx, request.params.id, request.body),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    route: 'PATCH /datasets/:id/fields/:key',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить описание поля: подпись, семантика, формат, справочник, индекс',
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
    route: 'POST /datasets/:id/fields/:key/convert',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Сменить тип поля: пробный прогон с отчётом или применение',
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
    route: 'DELETE /datasets/:id/fields/:key',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить поле вместе с его данными',
    handler: async (request) => {
      await db().transaction((tx) =>
        SchemaService.removeField(tx, request.ctx, request.params.id, request.params.key),
      )
      return DatasetService.get(request.params.id)
    },
  })

  route({
    route: 'GET /sql/schema',
    auth: 'session',
    tags: ['data'],
    summary: 'SQL-лаборатория: датасеты и поля для подсказок',
    handler: async (request) => SqlService.schema(request.ctx),
  })

  route({
    route: 'POST /sql/run',
    auth: 'session',
    tags: ['data'],
    summary: 'SQL-лаборатория: выполнить SELECT над датасетами с политиками пользователя',
    readOnly: true,
    handler: async (request) => QueryService.runSql(request.ctx, request.body),
  })

  route({
    route: 'POST /datasets/:id/exports',
    auth: { delegated: 'ExportService.start', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Экспорт датасета в CSV, XLSX, JSON или GeoJSON — задание с файлом',
    handler: async (request) => ExportService.start(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /datasets/exports/:jobId/download',
    auth: {
      owned: 'ExportService.download — только инициатор экспорта, с правом export на датасет',
    },
    tags: ['data'],
    summary: 'Ссылка на файл экспорта — только запросившему',
    handler: async (request) => ExportService.download(request.ctx, request.params.jobId),
  })

  route({
    route: 'POST /datasets/:id/versions/:number/rollback',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Откатить датасет к прежней версии — новой версией (ADR-0062)',
    handler: async (request) =>
      RollbackService.rollback(request.ctx, request.params.id, request.params.number),
  })

  route({
    route: 'GET /datasets/:id/policies',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Политики строк и столбцов датасета',
    handler: async (request) => PolicyService.list(request.params.id),
  })

  route({
    route: 'POST /datasets/:id/policies/rows',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику строк: кому и какие строки видны',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createRow(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'PATCH /datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику строк',
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
    route: 'DELETE /datasets/:id/policies/rows/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику строк',
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeRow(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /datasets/:id/policies/columns',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Добавить политику столбцов: скрыть или замаскировать поля',
    handler: async (request) =>
      db().transaction((tx) =>
        PolicyService.createColumn(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'PATCH /datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Изменить политику столбцов',
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
    route: 'DELETE /datasets/:id/policies/columns/:policyId',
    auth: { action: 'manage' },
    tags: ['data'],
    summary: 'Удалить политику столбцов',
    handler: async (request) => {
      await db().transaction((tx) =>
        PolicyService.removeColumn(tx, request.ctx, request.params.id, request.params.policyId),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /queries/run',
    auth: 'session',
    tags: ['data'],
    summary: 'Выполнить QuerySpec: источники с политиками пользователя, результат столбцами',
    readOnly: true,
    handler: async (request) =>
      QueryService.run(request.ctx, request.body.spec, { params: request.body.params }),
  })

  route({
    route: 'POST /datasets/:id/ask',
    auth: { action: 'view', capability: 'ai.use' },
    tags: ['data', 'ai'],
    summary: 'Спросить данные: вопрос → план модели → проверенный запрос и результат',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) =>
      AskService.ask(request.ctx, request.params.id, request.body.question),
  })

  route({
    route: 'POST /datasets/:id/rows/query',
    auth: { delegated: 'RowService.query', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Страница строк таблицы датасета: фильтр, поиск, сортировка, счётчик',
    handler: async (request) => RowService.query(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /datasets/:id/rows',
    auth: { delegated: 'RowService.insert', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Добавить строки (до 1000)',
    handler: async (request) => ({
      items: await RowService.insert(request.ctx, request.params.id, request.body.rows),
    }),
  })

  route({
    route: 'POST /datasets/:id/rows/batch',
    auth: { delegated: 'RowService (applyRowsBatch, queueRowsBatch)', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Массовая правка строк: вставка, изменение и удаление одним запросом',
    description:
      'Пачка применяется целиком или не применяется вовсе. Больше 500 операций ' +
      'или `async: true` — ответ 202 с `jobId`, состояние — `GET /jobs/{jobId}`.',
    handler: async (request, reply) => {
      const input = request.body
      if (input.async || batchSize(input) > BATCH_INLINE_LIMIT) {
        const jobId = await queueRowsBatch(request.ctx, request.params.id, input)
        reply.code(202)
        return { jobId }
      }
      return applyRowsBatch(request.ctx, request.params.id, input)
    },
  })

  route({
    route: 'POST /datasets/:id/rows/delete',
    auth: { delegated: 'RowService.remove', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Удалить строки (до 1000)',
    handler: async (request) => ({
      deleted: await RowService.remove(request.ctx, request.params.id, request.body.ids),
    }),
  })

  route({
    route: 'GET /datasets/:id/rows/:rowId',
    auth: { delegated: 'RowService.get', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Строка датасета',
    handler: async (request) =>
      RowService.get(request.ctx, request.params.id, request.params.rowId),
  })

  route({
    route: 'PATCH /datasets/:id/rows/:rowId',
    auth: { delegated: 'RowService.update', objectType: 'dataset' },
    tags: ['data'],
    summary: 'Изменить строку; конфликт версии — 409 с текущими значениями',
    handler: async (request) =>
      RowService.update(request.ctx, request.params.id, request.params.rowId, request.body),
  })

  route({
    route: 'GET /datasets/:id/rows/:rowId/history',
    auth: { delegated: 'RowService.history', objectType: 'dataset' },
    tags: ['data'],
    summary: 'История изменений строки',
    handler: async (request) => ({
      items: await RowService.history(request.ctx, request.params.id, request.params.rowId),
    }),
  })

  route({
    route: 'GET /datasets/:id/versions',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Версии датасета',
    handler: async (request) => ({ items: await DatasetService.versions(request.params.id) }),
  })

  route({
    route: 'GET /datasets/:id/imports',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Импорты датасета (сводки изменений — без примеров)',
    handler: async (request) => ({
      items: (await ImportService.list(request.params.id)).map(ImportService.withoutSamples),
    }),
  })

  route({
    route: 'POST /datasets/imports/analyze',
    auth: 'session',
    tags: ['data'],
    summary: 'Анализ файла для импорта: формат, типы, семантика, предпросмотр',
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.body.fileId)
      return ImportService.analyze(request.body)
    },
  })

  route({
    route: 'POST /datasets/imports',
    auth: 'session',
    tags: ['data'],
    summary: 'Запустить импорт файла в новый или существующий датасет',
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
    route: 'GET /datasets/imports/:id',
    auth: { delegated: 'ImportService.get → DatasetAccess.resolve', resource: 'import' },
    tags: ['data'],
    summary: 'Состояние импорта; сводка изменений — с политиками пользователя (ADR-0068)',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      const grant = await DatasetAccess.resolve(request.ctx, record.datasetId, 'view')
      const canImport = (await authorize(request.ctx, 'import', record.datasetId, { soft: true }))
        .allowed
      const { primaryKey } = await DatasetService.storage(record.datasetId)
      return ImportService.visible(record, grant, canImport, primaryKey)
    },
  })

  route({
    route: 'POST /datasets/imports/:id/publish',
    auth: { delegated: 'authorize(import)', resource: 'import' },
    tags: ['data'],
    summary: 'Опубликовать импорт после предпросмотра изменений: загрузка в датасет',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      await authorize(request.ctx, 'import', record.datasetId)
      return ImportService.withoutSamples(
        await ImportService.publish(request.ctx, request.params.id),
      )
    },
  })

  route({
    route: 'POST /datasets/imports/:id/cancel',
    auth: { delegated: 'authorize(import)', resource: 'import' },
    tags: ['data'],
    summary: 'Отменить импорт после предпросмотра изменений: датасет не меняется',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      await authorize(request.ctx, 'import', record.datasetId)
      return ImportService.withoutSamples(
        await ImportService.cancel(request.ctx, request.params.id),
      )
    },
  })

  route({
    route: 'POST /charts',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать график',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => ChartService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /charts/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'График: спецификация',
    handler: async (request) => ChartService.get(request.params.id),
  })

  route({
    route: 'PATCH /charts/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить график: название, спецификация',
    handler: async (request) => {
      await db().transaction((tx) =>
        ChartService.update(tx, request.ctx, request.params.id, request.body),
      )
      return ChartService.get(request.params.id)
    },
  })

  route({
    route: 'POST /charts/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные графика — с политиками пользователя',
    readOnly: true,
    handler: async (request) => {
      const chart = await ChartService.get(request.params.id)
      return runChartSpec(request.ctx, chart.spec, {
        ...chart.paramsDefaults,
        ...request.body.params,
      })
    },
  })

  route({
    route: 'POST /dashboards',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать дашборд',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        DashboardService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /dashboards/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Дашборд: плитки и фильтры',
    handler: async (request) => DashboardService.get(request.params.id),
  })

  route({
    route: 'PATCH /dashboards/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить дашборд: название, плитки, фильтры',
    handler: async (request) => {
      await db().transaction((tx) =>
        DashboardService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DashboardService.get(request.params.id)
    },
  })

  route({
    route: 'POST /dashboards/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные плиток дашборда одним запросом, с фильтрами дашборда',
    // Чтение: доступно и странице печати отчёта с токеном печати (блок «Дашборд», ADR-0164)
    readOnly: true,
    handler: async (request) => DashboardService.data(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /dashboards/:id/drill',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Детализация плитки до строк: выбранный элемент графика и фильтры дашборда',
    handler: async (request) =>
      DashboardService.drill(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /system-datasets/:name',
    auth: { open: 'имя системного датасета — справочник полей; строки — по политикам датасета' },
    tags: ['data'],
    summary: 'Схема системного датасета: поля для подписей показателей (ADR-0082)',
    handler: async (request) => systemDatasetSchema(request.ctx, request.params.name),
  })

  route({
    route: 'POST /metrics',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать показатель',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => MetricService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /metrics/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Показатель: определение, цели, пороги',
    handler: async (request) => MetricService.get(request.params.id),
  })

  route({
    route: 'PATCH /metrics/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить показатель',
    handler: async (request) => {
      await db().transaction((tx) =>
        MetricService.update(tx, request.ctx, request.params.id, request.body),
      )
      return MetricService.get(request.params.id)
    },
  })

  route({
    route: 'POST /metrics/:id/value',
    auth: { action: 'view' },
    tags: ['data'],
    summary:
      'Значение показателя: сравнение, статус порога, история и разрез — с политиками пользователя',
    readOnly: true,
    handler: async (request) =>
      MetricService.evaluate(request.ctx, await MetricService.get(request.params.id), request.body),
  })

  route({
    route: 'POST /internal/data/imports/:id/normalized',
    auth: { engineJob: { scope: (params) => `import:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок сообщает итог нормализации файла импорта (ADR-0046)',
    handler: async (request) => ({
      loadJobId: await ImportService.acceptNormalized(request.params.id, request.body),
    }),
  })
}

/** Фоновая часть: загрузка импорта воркером и реакция на окончательный сбой заданий. */
export function registerDataBackground(): void {
  registerAnalysisBackground()
  registerNotebookBackground()
  registerPipelineBackground()
  registerSourceBackground()

  registerJobHandler({
    queue: ROWS_BATCH_JOB.queue,
    name: ROWS_BATCH_JOB.name,
    concurrency: 2,
    handle: async (job) =>
      runQueuedRowsBatch(
        job.data as { datasetId: string; initiatorId: string; input: DatasetRowsBatch },
      ),
  })

  registerJobHandler({
    queue: LOAD_JOB.queue,
    name: LOAD_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => ImportService.load(job.data, helpers.progress, helpers.signal),
  })

  registerJobHandler({
    queue: COMPARE_JOB.queue,
    name: COMPARE_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) =>
      ImportService.compare(job.data, helpers.progress, helpers.signal),
  })

  registerJobHandler({
    queue: EXPORT_JOB.queue,
    name: EXPORT_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => ExportService.run(job.data as ExportJobData, helpers),
  })

  registerJobHandler({
    queue: 'index',
    name: 'data.quality-check',
    concurrency: 2,
    handle: async (job) => ({ status: await QualityService.check(String(job.data.datasetId)) }),
  })

  // Срок хранения истории строк (ADR-0173): версии старше срока — ночью, пачками
  registerJobHandler({
    queue: 'maintenance',
    name: 'data.history-prune',
    concurrency: 1,
    handle: async () => ({ ...(await HistoryRetention.prune()) }),
  })

  // Новая версия — повод проверить качество (ADR-0101): считаем заданием,
  // чтобы шина событий не ждала запросов по всей таблице
  registerSubscriber({
    name: 'data-quality',
    types: ['dataset.version_created'],
    handle: async (event) => {
      if (!event.object) return
      await JobService.enqueue(systemCtx('data.quality'), {
        queue: 'index',
        name: 'data.quality-check',
        data: { datasetId: event.object.id },
        objectId: event.object.id,
        idempotencyKey: `data.quality-check:${event.id}`,
      })
    },
  })

  // Новая версия данных — копия устарела; крупный датасет пересобирается сам (ADR-0109)
  registerSubscriber({
    name: 'data-columnar-version',
    types: ['dataset.version_created'],
    handle: async (event) => {
      if (!event.object) return
      await ColumnarService.onVersionCreated(systemCtx('data.columnar'), event.object.id)
    },
  })

  // Итог сборки копии: движок сообщает его результатом задания (ADR-0035)
  registerSubscriber({
    name: 'data-columnar-job',
    types: ['job.finished', 'job.failed', 'job.cancelled'],
    handle: async (event) => {
      const jobId = String(event.payload.jobId ?? '')
      if (!jobId) return
      const job = await JobService.get(jobId)
      if (job?.queue !== COLUMNAR_BUILD_JOB.queue || job.name !== COLUMNAR_BUILD_JOB.name) return
      const payload = ColumnarBuildJob.pick({ datasetId: true }).safeParse(
        await JobService.payload(jobId),
      )
      if (!payload.success) return
      const { datasetId } = payload.data
      if (event.type !== 'job.finished') {
        await ColumnarService.markFailed(
          datasetId,
          closedReason(event, 'Сбой сборки колоночной копии'),
        )
        return
      }
      // Результат движка — по контракту задания (ADR-0190); расхождение — сбой сборки
      const result = ColumnarBuildJobResult.safeParse(job.result)
      if (!result.success) {
        await ColumnarService.markFailed(datasetId, 'Движок вернул результат не по контракту')
        return
      }
      await ColumnarService.finish(datasetId, result.data)
    },
  })

  // Отменённое задание импорта (ADR-0172) закрывает импорт так же, как сбой:
  // иначе он навсегда остался бы «загружается»
  registerSubscriber(
    jobClosedSubscriber({
      name: 'data-import-failed',
      jobs: [NORMALIZE_JOB, COMPARE_JOB, LOAD_JOB],
      onClosed: async ({ payload, reason }) => {
        const importId = typeof payload?.importId === 'string' ? payload.importId : null
        if (importId) await ImportService.markFailed(importId, reason)
      },
    }),
  )
}

/** Расписания пайплайнов и внешних источников при старте воркера (ADR-0106, ADR-0107). */
export function declareDataSchedules(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'data.history-prune',
    pattern: '37 3 * * *',
    labelKey: 'schedules.jobs.dataHistoryPrune',
  })
  declarePipelineSchedules()
  declareSourceSchedules()
}

export async function scheduleDataJobs(): Promise<void> {
  await schedulePipelineJobs()
  await scheduleSourceJobs()
}
