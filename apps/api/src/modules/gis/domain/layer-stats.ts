import { createHash } from 'node:crypto'
import {
  type FieldType,
  type FilterNode,
  type LayerStats,
  type LayerStatsInput,
  QuerySpec,
} from '@kchs/contracts'
import { classifySummary } from '@kchs/map-style'
import { cacheKeyText } from '@kchs/query'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { queryRoleSql } from '~/shared/db/client.js'
import { pgErrorCode } from '~/shared/db/pg-error.js'
import { errors } from '~/shared/errors.js'
import { redis } from '~/shared/redis/index.js'
import { LayerService } from './layer-service.js'

const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
/**
 * Значений для квантилей и естественных границ: слой не больше — все значения,
 * крупнее — случайная выборка такого размера (Дженкс всё равно берёт из неё
 * 2 000 значений по рангу, квантили по 10 000 точнее процента ранга).
 */
export const LAYER_STATS_SAMPLE = 10_000
/** Статистика меняется только с данными, политиками и фильтром — они в ключе. */
const CACHE_TTL_SECONDS = 24 * 3600
/** Полный просмотр крупного слоя: дольше тайла, но в пределах интерактивного ожидания. */
const STATS_TIMEOUT_MS = 20_000
const QUERY_CANCELED = '57014'

type Row = Record<string, unknown>

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Имя поля в выражении: в кавычках, как любое поле с произвольным ключом. */
const ref = (key: string) => `"${key}"`

/** Имя вычисляемого значения, не совпадающее с полями датасета. */
function valueName(fields: ReadonlyMap<string, FieldType>): string {
  let name = 'kchs_value'
  for (let n = 2; fields.has(name); n += 1) name = `kchs_value_${n}`
  return name
}

async function execute(sql: string, params: readonly unknown[]): Promise<Row[]> {
  try {
    const rows = await queryRoleSql().begin('read only', async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${String(STATS_TIMEOUT_MS)}, true)`
      return tx.unsafe(sql, params as never[])
    })
    return rows as unknown as Row[]
  } catch (error) {
    if (pgErrorCode(error) === QUERY_CANCELED) {
      throw errors.queryTimeout('Статистика слоя не рассчитана за отведённое время')
    }
    throw error
  }
}

/**
 * Статистика поля слоя для классов и диапазонов стиля (07-gis-engine.md §4,
 * ADR-0075): агрегаты по всем строкам слоя через компилятор запросов с
 * политиками смотрящего — минимум, максимум, пустые, среднее и отклонение;
 * квантили и естественные границы — по значениям слоя (крупный слой — по
 * случайной выборке). Границы строит тот же код, что у клиента
 * (`classifySummary`). Кэш — Redis по ключу компиляции: версия данных,
 * отпечаток политик и фильтр.
 */
export const LayerStatsService = {
  async stats(ctx: Ctx, layerId: string, input: LayerStatsInput): Promise<LayerStats> {
    const layer = await LayerService.load(layerId)
    // Без доступа к датасету — 404, как у тайлов: права на слой данных не открывают
    const visible = await DatasetQueries.visibleFields(ctx, layer.datasetId)
    for (const key of [input.field, input.normalizeBy]) {
      if (key === null) continue
      const type = visible.get(key)
      if (!type) throw errors.validation(`В датасете слоя нет поля «${key}»`)
      if (!NUMERIC.has(type)) throw errors.validation(`Поле «${key}» — не число`)
    }
    const filter: FilterNode | null = input.filter === undefined ? layer.style.filter : input.filter
    // Значение — всегда вещественное: целые не переполняются в квадрате, деление на
    // ноль при нормализации — пусто
    const value = valueName(visible)
    const prefix = [
      ...(filter ? [{ type: 'filter', where: filter }] : []),
      {
        type: 'compute',
        fields: [
          {
            name: value,
            expr: `safe_div(${ref(input.field)}, ${input.normalizeBy ? ref(input.normalizeBy) : '1'})`,
            type: 'number',
          },
        ],
      },
    ]
    const summarySpec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: layer.datasetId },
      steps: [
        ...prefix,
        {
          type: 'aggregate',
          measures: [
            { alias: 'total', agg: 'count' },
            { alias: 'filled', agg: 'count', field: value },
            { alias: 'v_min', agg: 'min', field: value },
            { alias: 'v_max', agg: 'max', field: value },
            { alias: 'v_mean', agg: 'avg', field: value },
            { alias: 'v_mean_sq', agg: 'expr', expr: `avg(${ref(value)} * ${ref(value)})` },
            {
              alias: 'v_min_positive',
              agg: 'min',
              field: value,
              filter: { field: value, op: 'gt', value: 0 },
            },
          ],
        },
      ],
      options: { cache: false },
    })
    const summary = await DatasetQueries.compile(ctx, summarySpec, { maxRows: 1 })
    const key = createHash('sha256')
      .update(
        `${cacheKeyText(summary.compiled.cacheKeyParts)}|${summary.schemaVersions}|${input.method}|${input.classes}`,
      )
      .digest('hex')
    const cacheKey = `kchs:layer-stats:${layerId}:${key}`
    const hit = await redis().get(cacheKey)
    if (hit) return JSON.parse(hit) as LayerStats

    const [row = {}] = await execute(summary.compiled.sql, summary.compiled.params)
    const count = toNumber(row.total) ?? 0
    const filled = toNumber(row.filled) ?? 0
    const min = toNumber(row.v_min)
    const max = toNumber(row.v_max)
    const mean = toNumber(row.v_mean)
    const meanSquare = toNumber(row.v_mean_sq)
    // Дисперсия как E[x²] − E[x]² — один проход; отрицательный остаток округления — ноль
    const stddev =
      mean === null || meanSquare === null ? null : Math.sqrt(Math.max(0, meanSquare - mean ** 2))

    let breaks: number[] | null = null
    let sample: number | null = null
    if (input.method && min !== null && max !== null) {
      let values: number[] | null = null
      if (input.method === 'quantile' || input.method === 'jenks') {
        const sampled = filled > LAYER_STATS_SAMPLE
        const valuesSpec = QuerySpec.parse({
          version: 1,
          source: { kind: 'dataset', id: layer.datasetId },
          steps: [
            ...prefix,
            { type: 'filter', where: { field: value, op: 'not_empty' } },
            { type: 'select', fields: [value] },
            ...(sampled ? [{ type: 'sample', n: LAYER_STATS_SAMPLE }] : []),
          ],
          options: { cache: false },
        })
        const compiled = await DatasetQueries.compile(ctx, valuesSpec, {
          maxRows: LAYER_STATS_SAMPLE,
        })
        const rows = await execute(compiled.compiled.sql, compiled.compiled.params)
        values = rows
          .slice(0, LAYER_STATS_SAMPLE)
          .map((item) => toNumber(item[value]))
          .filter((item): item is number => item !== null)
        if (sampled) sample = values.length
      }
      breaks = classifySummary(
        {
          min,
          max,
          mean,
          stddev,
          minPositive: toNumber(row.v_min_positive),
          sample: values,
        },
        input.method,
        input.classes,
      )
    }

    const stats: LayerStats = {
      field: input.field,
      normalizeBy: input.normalizeBy,
      count,
      nulls: Math.max(0, count - filled),
      min,
      max,
      mean,
      stddev,
      breaks,
      method: input.method,
      classes: input.method ? input.classes : null,
      sample,
    }
    await redis().set(cacheKey, JSON.stringify(stats), 'EX', CACHE_TTL_SECONDS)
    return stats
  },
}
