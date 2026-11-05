import { useQueries } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import type { MapOverlayData, MapOverlayZone } from '~/features/gis/index.js'
import { territoryGeometryQuery } from '~/features/gis/index.js'
import { useT } from '~/shared/i18n.js'
import { warningQuery } from './queries.js'
import { activeWarnings } from './situation.js'
import { usePublishedWarnings } from './use-situation.js'

/** Зум упрощения границ — как у карты областей предупреждения. */
const GEOMETRY_ZOOM = 8
/** Действующих предупреждений на карте — не больше: зоны каждого читаются по записи. */
const MAX_WARNINGS = 12

/**
 * Зоны действующих предупреждений для карт gis (ADR-0230): поставщик наложения без
 * разметки. Список — тот же, что у полосы обстановки (видимые сотруднику); области
 * каждого — из записи предупреждения: граница территории справочника или свои точки.
 * Цвет зоны — уровень по строгости CAP. Экрана предупреждений нет или запрос не прошёл —
 * `null`: карта наложение не показывает.
 */
export function WarningZonesFeed({ onData }: { onData: (data: MapOverlayData | null) => void }) {
  const t = useT()
  const items = usePublishedWarnings()
  const active = useMemo(
    () => (items ? activeWarnings(items, Date.now()).slice(0, MAX_WARNINGS) : []),
    [items],
  )
  const records = useQueries({
    queries: active.map(({ warning }) => warningQuery(warning.id)),
  })
  const territoryIds = [
    ...new Set(
      records.flatMap((query) =>
        (query.data?.areas ?? []).flatMap((area) => (area.territoryId ? [area.territoryId] : [])),
      ),
    ),
  ]
  const geometries = useQueries({
    queries: territoryIds.map((id) => territoryGeometryQuery(id, GEOMETRY_ZOOM)),
  })

  const recordsKey = records.map((query) => query.data?.id ?? '').join(',')
  const geometryKey = geometries.map((query) => query.data?.id ?? '').join(',')
  const label = t('shell.opsBand.zones')
  // biome-ignore lint/correctness/useExhaustiveDependencies: пересчёт — по загруженным записям и границам
  const data = useMemo((): MapOverlayData | null => {
    if (!items) return null
    const shapes = new Map(
      geometries.flatMap((query) =>
        query.data ? [[query.data.id, query.data.geometry] as const] : [],
      ),
    )
    const zones: MapOverlayZone[] = []
    active.forEach(({ warning, level }, index) => {
      for (const area of records[index]?.data?.areas ?? []) {
        const geometry = area.territoryId ? shapes.get(area.territoryId) : undefined
        if (geometry) {
          zones.push({
            geometry: geometry as MapOverlayZone['geometry'],
            level,
            title: warning.title,
            territoryId: area.territoryId ?? undefined,
            objectId: warning.id,
            objectType: 'warning',
          })
        } else if (area.polygon && area.polygon.length >= 3) {
          const ring = [...area.polygon, area.polygon[0]]
          zones.push({
            geometry: { type: 'Polygon', coordinates: [ring] },
            level,
            title: warning.title,
            objectId: warning.id,
            objectType: 'warning',
          })
        }
      }
    })
    return { label, zones }
  }, [items, active, recordsKey, geometryKey, label])

  useEffect(() => onData(data), [data, onData])
  return null
}
