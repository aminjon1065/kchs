import { createHash } from 'node:crypto'
import { type Bbox, QuerySpec } from '@kchs/contracts'
import { cacheKeyText } from '@kchs/query'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { readAsQueryRole } from '~/shared/db/query-role.js'
import { cache } from '~/shared/redis/index.js'
import { extentSql } from '../infra/layer-sql.js'
import { type LayerSourceRef, layerQuerySource, layerWindowSource } from './layer-source.js'

/** Сводка пересчитывается с новой версией данных или политикой (ключ компиляции). */
const CACHE_TTL_SECONDS = 3600
const TIMEOUT_MS = 10_000

export interface ViewerGeometry {
  extent: Bbox | null
  count: number
}

/**
 * Экстент и число объектов слоя в пределах политики строк смотрящего (ADR-0064):
 * рамка и счётчик по всем строкам раскрывали бы, где лежат и сколько строк,
 * скрытых политикой. Без политики строк — null: хватает общей сводки датасета.
 * У системного источника (ADR-0223) сводки датасета нет, а версия данных не меняется:
 * считается всегда и без кэша.
 */
export async function viewerGeometry(
  ctx: Ctx,
  layer: LayerSourceRef,
  geometryField: string,
): Promise<ViewerGeometry | null> {
  const system = layer.systemSource !== null
  const sourceId = layerWindowSource(layer)
  const spec = QuerySpec.parse({
    version: 1,
    source: layerQuerySource(layer),
    steps: [{ type: 'select', fields: [geometryField] }],
    options: { cache: false },
  })
  const { compiled, schemaVersions } = await DatasetQueries.compile(ctx, spec, {
    geometryOutput: 'raw',
    maxRows: null,
  })
  if (!system) {
    const source = compiled.cacheKeyParts.datasets.find((item) => item.id === sourceId)
    const policy = source ? (JSON.parse(source.policy) as { row?: { kind?: string } }) : null
    if (!policy?.row || policy.row.kind === 'all') return null
  }

  const key = `kchs:geo:viewer:${createHash('sha256')
    .update(`${cacheKeyText(compiled.cacheKeyParts)}|${schemaVersions}`)
    .digest('hex')}`
  const cached = system ? null : await cache.get(key)
  if (cached) return JSON.parse(cached) as ViewerGeometry

  const rows = await readAsQueryRole({ timeoutMs: TIMEOUT_MS }, (read) =>
    read.rows(extentSql(compiled, geometryField)),
  )
  const row = rows[0] as
    | {
        minx: number | null
        miny: number | null
        maxx: number | null
        maxy: number | null
        c: number
      }
    | undefined
  const summary: ViewerGeometry = {
    extent:
      row && row.minx !== null && row.miny !== null && row.maxx !== null && row.maxy !== null
        ? [Number(row.minx), Number(row.miny), Number(row.maxx), Number(row.maxy)]
        : null,
    count: Number(row?.c ?? 0),
  }
  if (!system) await cache.set(key, JSON.stringify(summary), CACHE_TTL_SECONDS)
  return summary
}
