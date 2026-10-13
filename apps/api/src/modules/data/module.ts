import { ColumnarBuildJob, ColumnarBuildJobResult, type DatasetRowsBatch } from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { closedReason, jobClosedSubscriber } from '~/kernel/jobs/outcomes.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { logger } from '~/shared/logger/index.js'
import { registerAnalysisBackground, registerAnalysisRoutes } from './analysis-module.js'
import { AskService } from './domain/ask-service.js'
import { COLUMNAR_BUILD_JOB, ColumnarService } from './domain/columnar-service.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { EXPORT_JOB, type ExportJobData, ExportService } from './domain/export-service.js'
import { HistoryRetention } from './domain/history-retention.js'
import { COMPARE_JOB, ImportService, LOAD_JOB, NORMALIZE_JOB } from './domain/import-service.js'
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
import { registerExportRoutes } from './export-module.js'
import { registerImportRoutes } from './import-module.js'
import { Physical } from './infra/physical.js'
import { registerNotebookBackground, registerNotebookRoutes } from './notebook-module.js'
import {
  declarePipelineSchedules,
  registerPipelineBackground,
  registerPipelineRoutes,
  schedulePipelineJobs,
} from './pipeline-module.js'
import { registerDatasetPolicyRoutes } from './policy-module.js'
import {
  declareSourceSchedules,
  registerSourceBackground,
  registerSourceRoutes,
  scheduleSourceJobs,
} from './source-module.js'
import { registerVisualizationRoutes } from './viz-module.js'

/** Таблицы датасетов, созданные прежними версиями, — к текущему виду (при старте). */
export async function upgradeDataStorage(): Promise<void> {
  const upgraded = await Physical.upgradeHistoryTables()
  if (upgraded > 0) logger().info({ upgraded }, 'таблицы истории строк дополнены номером версии')
  const keys = await Physical.upgradeKeyIndexes()
  if (keys > 0) logger().info({ keys }, 'индексы ключа строк — только по живым строкам (ADR-0160)')
}

export function registerDataRoutes(route: RouteRegistrar): void {
  registerDatasetPolicyRoutes(route)
  registerImportRoutes(route)
  registerVisualizationRoutes(route)
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
