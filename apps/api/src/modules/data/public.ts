/**
 * Публичный API модуля «Данные» для других модулей и служебных команд
 * (01-overview.md §Как модули взаимодействуют).
 */
import type {
  DashboardCreateInput,
  DatasetRecord,
  DatasetRow,
  DatasetRowPatch,
  FieldType,
  MetricCreateInput,
  MetricRecord,
  MetricValue,
  NotebookRecord,
  QueryResult,
  QuerySpec,
} from '@kchs/contracts'
import type { CompiledQuery } from '@kchs/query'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { AskService } from './domain/ask-service.js'
import { DashboardService } from './domain/dashboard-service.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { type MetricEvaluation, MetricService } from './domain/metric-service.js'
import { NotebookService } from './domain/notebook-service.js'
import { QueryService, type RunOptions } from './domain/query-service.js'
import { RowService, type RowWriteAccess, type RowWriteOptions } from './domain/row-service.js'

export { DatasetGeo, type DatasetGeometry } from './domain/dataset-geo.js'
export {
  DEMO_PROFILES,
  DEMO_SEED,
  DemoData,
  type DemoDataResult,
  type DemoProfile,
} from './domain/demo-data.js'
/**
 * Выгрузка таблицы в CSV или XLSX тем же кодом, что экспорт датасета (ADR-0056):
 * столбцы с типами, строки пачками, даты — по часам запросившего. Нужна отчётам
 * модулей (контроль исполнения, ADR-0082).
 */
export { type ExportColumn, writeExport as writeTable } from './infra/export-format.js'

/** Описание датасета: схема полей, ключ, версии (без физических имён). */
export const datasetRecord = (id: string): Promise<DatasetRecord> => DatasetService.get(id)

/** Каталог датасетов для других модулей: с полем территории (паспорт, ADR-0077). */
export const DatasetCatalog = {
  withTerritory: (ctx: Ctx, limit = 50): Promise<DatasetRecord[]> =>
    DatasetService.withTerritory(ctx, limit),
}

/**
 * Показатели (ADR-0058): значение — тем же путём кода, что у дашборда и карточки,
 * с политиками смотрящего. Право видеть сам показатель проверяет вызывающий.
 */
export const Metrics = {
  get: (id: string): Promise<MetricRecord> => MetricService.get(id),
  /**
   * Показатель, который заводит модуль (контроль исполнения над системным
   * датасетом «Поручения», ADR-0082): `systemKey` в сводке объекта — по нему
   * модуль находит свой показатель.
   */
  create: (
    tx: Executor,
    ctx: Ctx,
    input: MetricCreateInput,
    options: { systemKey?: string } = {},
  ): Promise<string> => MetricService.create(tx, ctx, input, options),
  value: (ctx: Ctx, metric: MetricRecord, evaluation: MetricEvaluation): Promise<MetricValue> =>
    MetricService.evaluate(ctx, metric, evaluation),
}

/**
 * Дашборд, который заводит модуль (канцелярия над системным датасетом
 * «Документы», ADR-0086): `systemKey` в сводке объекта — по нему модуль находит
 * свой дашборд и не заводит его повторно.
 */
export const Dashboards = {
  create: async (
    tx: Executor,
    ctx: Ctx,
    input: DashboardCreateInput,
    options: { systemKey?: string } = {},
  ): Promise<string> => {
    const id = await DashboardService.create(tx, ctx, input)
    if (options.systemKey) {
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: { systemKey: options.systemKey }, mergeMeta: true },
        { silent: true },
      )
    }
    return id
  },
}

/** Снимок тетради — «Экспорт в отчёт» (P2-E05 S03); право `view` проверяет вызывающий. */
export const notebookRecord = (id: string): Promise<NotebookRecord> => NotebookService.get(id)

/**
 * Запрос к датасетам с правами и политиками смотрящего: компиляция для обёртки
 * вызывающим (векторные тайлы, ADR-0064) и выполнение с кэшем.
 */
export const DatasetQueries = {
  compile: (
    ctx: Ctx,
    spec: QuerySpec,
    options?: RunOptions,
  ): Promise<{ compiled: CompiledQuery; schemaVersions: string; cacheable: boolean }> =>
    QueryService.compile(ctx, spec, options),
  run: (ctx: Ctx, spec: QuerySpec, options?: RunOptions): Promise<QueryResult> =>
    QueryService.run(ctx, spec, options),
  /** Строка по `_id` с политиками смотрящего (как в таблице). */
  row: (ctx: Ctx, datasetId: string, rowId: string): Promise<DatasetRow> =>
    RowService.get(ctx, datasetId, rowId),
  /** Ключи полей, видимых смотрящему (скрытые политикой столбцов — нет). */
  /** Поля, видимые смотрящему (без скрытых политикой столбцов), с типами — по порядку схемы. */
  visibleFields: async (ctx: Ctx, datasetId: string): Promise<Map<string, FieldType>> => {
    const [grant, storage] = await Promise.all([
      DatasetAccess.resolve(ctx, datasetId),
      DatasetService.storage(datasetId),
    ])
    return new Map(
      storage.fields
        .filter((field) => !grant.hidden.has(field.key))
        .map((field) => [field.key, field.type]),
    )
  },
}

export type { RowWriteAccess, RowWriteOptions }

/**
 * Запись строк для других модулей (правка объектов слоя, ADR-0076): те же права,
 * проверки значений, история, версия и `dataset.rows_changed`, что у таблицы, —
 * в транзакции вызывающего, вместе с его событиями.
 */
export const DatasetRows = {
  /** Пишет ли пользователь строки напрямую; если нет — почему. */
  access: (ctx: Ctx, datasetId: string): Promise<RowWriteAccess> =>
    RowService.writeAccess(ctx, datasetId),
  /** Проверка значений с правами пользователя без записи; значения — в JSON-виде. */
  validate: (
    ctx: Ctx,
    datasetId: string,
    values: Record<string, unknown>,
    insert: boolean,
  ): Promise<Record<string, unknown>> => RowService.validate(ctx, datasetId, values, insert),
  insert: async (
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    values: Record<string, unknown>,
    options: RowWriteOptions = {},
  ): Promise<DatasetRow> => {
    const [row] = await RowService.insert(ctx, datasetId, [{ values }], tx, options)
    if (!row) throw errors.internal('Строка не добавлена')
    return row
  },
  /** Правка с версией строки: устаревшая — 409 с текущими значениями и изменёнными полями. */
  update: (
    tx: Executor,
    ctx: Ctx,
    datasetId: string,
    rowId: string,
    patch: DatasetRowPatch,
    options: RowWriteOptions = {},
  ): Promise<DatasetRow> => RowService.update(ctx, datasetId, rowId, patch, tx, options),
  /** Удаление строки той версии, что видел пользователь. */
  remove: (tx: Executor, ctx: Ctx, datasetId: string, rowId: string, ver: number) =>
    RowService.remove(ctx, datasetId, [rowId], tx, { ver }),
}

/**
 * «Спросить данные» для ассистента (ADR-0100): вопрос → план запроса → выборка
 * правами спрашивающего. Лимиты и аудит — общие, модуля ИИ.
 */
export const AskData = {
  ask: (ctx: UserCtx, datasetId: string, question: string) =>
    AskService.ask(ctx, datasetId, question),
}
