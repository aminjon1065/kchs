/**
 * Публичный API модуля «Данные» для других модулей и служебных команд
 * (01-overview.md §Как модули взаимодействуют).
 */
import type { DatasetRecord, DatasetRow, FieldType, QueryResult, QuerySpec } from '@kchs/contracts'
import type { CompiledQuery } from '@kchs/query'
import type { Ctx } from '~/shared/context.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { QueryService, type RunOptions } from './domain/query-service.js'
import { RowService } from './domain/row-service.js'

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
