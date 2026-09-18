import type { FieldProfile, StoredFieldType } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { db, type Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'
import { ident, qualified } from '../infra/physical.js'
import type { DatasetGrant } from './dataset-access.js'
import type { StoredField } from './dataset-service.js'

/** Строк в выборке профиля: больше — таблица читается выборкой страниц. */
const SAMPLE_ROWS = 200_000
const BINS = 20
const TOP = 10
const CACHE_TTL_SECONDS = 24 * 3600

const NUMERIC = new Set<StoredFieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
const TEMPORAL = new Set<StoredFieldType>(['date', 'datetime', 'time'])
/** Значения без осмысленных «частых»: только счётчики. */
const COUNTS_ONLY = new Set<StoredFieldType>(['json', 'long_text'])

type Profile = Omit<FieldProfile, 'version' | 'computedAt'>

/** Числовое значение для гистограммы: даты и время — секунды. */
function numericExpression(type: StoredFieldType): string {
  return TEMPORAL.has(type) ? 'extract(epoch from v)::float8' : 'v::float8'
}

/** Граница интервала гистограммы текстом по типу поля. */
function boundText(type: StoredFieldType, value: number): string {
  if (type === 'date') return new Date(value * 1000).toISOString().slice(0, 10)
  if (type === 'datetime') return new Date(value * 1000).toISOString()
  if (type === 'time') {
    const seconds = Math.round(value)
    const hh = String(Math.floor(seconds / 3600)).padStart(2, '0')
    const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  }
  return String(value)
}

/** Минимум и максимум текстом: даты и время — ISO 8601 (ADR-0028). */
function extremeText(type: StoredFieldType, aggregate: 'min' | 'max'): string {
  if (type === 'datetime') {
    return `to_char(${aggregate}(v) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
  }
  return `${aggregate}(v)::text`
}

async function compute(
  tx: Executor,
  table: string,
  field: StoredField,
  rowCount: number,
  masked: boolean,
): Promise<Profile> {
  const type = field.type as StoredFieldType
  const sampled = rowCount > SAMPLE_ROWS
  // SYSTEM берёт страницы целиком — быстро; запас в полтора раза на неравные страницы
  const percent = Math.min(100, (SAMPLE_ROWS / Math.max(rowCount, 1)) * 150)
  // Имена — сгенерированные и проверенные `ident`; числа — параметрами
  const base = sql`SELECT ${sql.raw(ident(field.physical))} AS v FROM ${sql.raw(qualified(table))}
    ${sampled ? sql`TABLESAMPLE SYSTEM (${percent}::real) REPEATABLE (42)` : sql``}
    WHERE _deleted_at IS NULL`
  const distinct = sql.raw(type === 'geometry' ? '0' : 'count(DISTINCT v)')

  const [counts] = await tx.execute<{ rows: string; empty: string; distinct: string }>(
    sql`SELECT count(*) AS rows, count(*) FILTER (WHERE v IS NULL) AS empty,
               ${distinct} AS distinct FROM (${base}) s`,
  )
  const profile: Profile = {
    field: field.key,
    type,
    rows: Number(counts?.rows ?? 0),
    sampled,
    empty: Number(counts?.empty ?? 0),
    distinct: Number(counts?.distinct ?? 0),
    masked,
    min: null,
    max: null,
    mean: null,
    histogram: [],
    top: [],
  }
  if (masked || profile.rows === profile.empty) return profile

  if (NUMERIC.has(type) || TEMPORAL.has(type)) {
    const value = sql.raw(numericExpression(type))
    const [range] = await tx.execute<{
      min: string | null
      max: string | null
      mean: number | null
      lo: number | null
      hi: number | null
    }>(
      sql`SELECT ${sql.raw(extremeText(type, 'min'))} AS min, ${sql.raw(extremeText(type, 'max'))} AS max,
                 ${sql.raw(NUMERIC.has(type) ? 'avg(v)::float8' : 'NULL::float8')} AS mean,
                 min(${value}) AS lo, max(${value}) AS hi
            FROM (${base}) s WHERE v IS NOT NULL`,
    )
    profile.min = range?.min ?? null
    profile.max = range?.max ?? null
    profile.mean = range?.mean ?? null
    const lo = Number(range?.lo)
    const hi = Number(range?.hi)
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (hi === lo) {
        const n = profile.rows - profile.empty
        profile.histogram = [{ from: boundText(type, lo), to: boundText(type, hi), count: n }]
      } else {
        const bins = await tx.execute<{ bin: number; n: string }>(
          sql`SELECT least(width_bucket(${value}, ${lo}::float8, ${hi}::float8, ${BINS}::int), ${BINS}::int) AS bin,
                     count(*) AS n
                FROM (${base}) s WHERE v IS NOT NULL GROUP BY 1 ORDER BY 1`,
        )
        const byBin = new Map(bins.map((row) => [Number(row.bin), Number(row.n)]))
        const width = (hi - lo) / BINS
        profile.histogram = Array.from({ length: BINS }, (_, index) => ({
          from: boundText(type, lo + index * width),
          to: boundText(type, index === BINS - 1 ? hi : lo + (index + 1) * width),
          count: byBin.get(index + 1) ?? 0,
        }))
      }
    }
    return profile
  }

  if (COUNTS_ONLY.has(type)) return profile
  const values =
    type === 'multi_select'
      ? sql`SELECT x AS value, count(*) AS n FROM (${base}) s, unnest(v) x GROUP BY x`
      : type === 'geometry'
        ? sql`SELECT extensions.st_geometrytype(v) AS value, count(*) AS n FROM (${base}) s
               WHERE v IS NOT NULL GROUP BY 1`
        : sql`SELECT v::text AS value, count(*) AS n FROM (${base}) s WHERE v IS NOT NULL GROUP BY v`
  const top = await tx.execute<{ value: string; n: string }>(
    sql`SELECT value, n FROM (${values}) t ORDER BY n DESC, value LIMIT ${TOP}`,
  )
  profile.top = top.map((row) => ({ value: row.value, count: Number(row.n) }))
  return profile
}

/**
 * Профиль столбца по запросу (06-analytics-engine.md §3 «Профиль столбцов»):
 * считается по выборке и кэшируется по версии данных и схемы. Виден тому, кто
 * видит все строки: при политике строк профиль раскрывал бы чужие значения.
 */
export const ProfileService = {
  async field(
    grant: DatasetGrant,
    storage: { table: string; fields: StoredField[] },
    dataset: { rowCount: number; currentVersion: number; schemaVersion: number },
    key: string,
  ): Promise<FieldProfile> {
    const field = storage.fields.find((item) => item.key === key)
    if (!field || grant.hidden.has(key)) throw errors.notFound('Поле')
    if (grant.rows.kind !== 'all') {
      throw errors.forbidden('Профиль столбца недоступен: строки датасета ограничены политикой')
    }
    const masked = grant.masked.has(key)
    const cacheKey = cacheKeys.datasetProfile(
      grant.datasetId,
      dataset.currentVersion,
      dataset.schemaVersion,
      `${key}:${masked ? 'masked' : 'full'}`,
    )
    const cached = await redis().get(cacheKey)
    if (cached) return JSON.parse(cached) as FieldProfile

    const profile = await db().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      return compute(tx, storage.table, field, dataset.rowCount, masked)
    })
    const result: FieldProfile = {
      ...profile,
      version: dataset.currentVersion,
      computedAt: new Date().toISOString(),
    }
    await redis().set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
    return result
  },
}
