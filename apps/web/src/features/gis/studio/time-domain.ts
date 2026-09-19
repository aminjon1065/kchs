import type { LayerRecord, QueryResult } from '@kchs/contracts'
import { useQueries, useQuery } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { type TimeDomain, wallFromValue } from './time-model.js'

/** Пояс пользователя (профиль), пока профиль не загружен — пояс браузера. */
export function useTimezone(): string {
  const { data: me } = useQuery(meQuery())
  return me?.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}

interface RawDomain {
  min: unknown
  max: unknown
  /** Тип поля времени: у даты нет часов — шаг «час» ей не нужен. */
  type: string | null
}

/**
 * Диапазон поля времени слоя: наименьшее и наибольшее значение агрегатом через
 * `/queries/run` — с политиками строк смотрящего и фильтром слоя, как тайлы.
 */
async function loadDomain(layer: LayerRecord): Promise<RawDomain> {
  const field = layer.style.time?.field
  if (!field) return { min: null, max: null, type: null }
  const steps: unknown[] = []
  if (layer.style.filter) steps.push({ type: 'filter', where: layer.style.filter })
  steps.push({
    type: 'aggregate',
    groupBy: [],
    measures: [
      { alias: 'tmin', agg: 'min', field },
      { alias: 'tmax', agg: 'max', field },
    ],
  })
  const result = await http.post<QueryResult>('/queries/run', {
    spec: { version: 1, source: { kind: 'dataset', id: layer.datasetId }, steps },
  })
  const row = result.rows[0] ?? []
  const index = (name: string) => result.fields.findIndex((item) => item.name === name)
  return {
    min: row[index('tmin')] ?? null,
    max: row[index('tmax')] ?? null,
    type: result.fields[index('tmin')]?.type ?? null,
  }
}

/**
 * Общий диапазон данных слоёв со временем (настенное время пояса пользователя);
 * null — данные ещё грузятся или значений времени нет.
 */
export function useTimeDomain(layers: readonly LayerRecord[]): {
  domain: TimeDomain | null
  loading: boolean
  /** У всех слоёв поле времени — дата-время: доступен шаг «час». */
  hourly: boolean
} {
  const timezone = useTimezone()
  const queries = useQueries({
    queries: layers.map((layer) => ({
      queryKey: ['layer', layer.id, 'time-domain', layer.version, layer.datasetVersion],
      queryFn: () => loadDomain(layer),
      staleTime: 5 * 60_000,
    })),
  })
  let min: number | null = null
  let max: number | null = null
  for (const query of queries) {
    const low = wallFromValue(query.data?.min, timezone)
    const high = wallFromValue(query.data?.max, timezone)
    if (low !== null) min = min === null ? low : Math.min(min, low)
    if (high !== null) max = max === null ? high : Math.max(max, high)
  }
  const types = queries.flatMap((query) => (query.data?.type ? [query.data.type] : []))
  return {
    domain: min !== null && max !== null ? { min, max } : null,
    loading: queries.some((query) => query.isLoading),
    hourly: types.length > 0 && types.every((type) => type === 'datetime'),
  }
}
