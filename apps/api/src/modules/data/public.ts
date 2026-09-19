/**
 * Публичный API модуля «Данные» для других модулей и служебных команд
 * (01-overview.md §Как модули взаимодействуют).
 */
import type {
  DatasetRecord,
  DatasetRow,
  DatasetRowPatch,
  FieldType,
  QueryResult,
  QuerySpec,
} from '@kchs/contracts'
import type { CompiledQuery } from '@kchs/query'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { QueryService, type RunOptions } from './domain/query-service.js'
import { RowService, type RowWriteAccess } from './domain/row-service.js'

export { DatasetGeo, type DatasetGeometry } from './domain/dataset-geo.js'
export {
  DEMO_PROFILES,
  DEMO_SEED,
  DemoData,
  type DemoDataResult,
  type DemoProfile,
} from './domain/demo-data.js'

/** Описание датасета: схема полей, ключ, версии (без физических имён). */
export const datasetRecord = (id: string): Promise<DatasetRecord> => DatasetService.get(id)

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

export type { RowWriteAccess }

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
  ): Promise<DatasetRow> => {
    const [row] = await RowService.insert(ctx, datasetId, [{ values }], tx)
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
  ): Promise<DatasetRow> => RowService.update(ctx, datasetId, rowId, patch, tx),
  /** Удаление строки той версии, что видел пользователь. */
  remove: (tx: Executor, ctx: Ctx, datasetId: string, rowId: string, ver: number) =>
    RowService.remove(ctx, datasetId, [rowId], tx, { ver }),
}
