import type { MapTheme } from '@kchs/map-style'
import type { HazardLevel, MapLayerSpecification, MapSourceSpecification } from '@kchs/ui'
import { type ReactNode, Suspense, useMemo, useState } from 'react'
import { type MapOverlayData, type MapOverlayZone, mapOverlays } from './map-overlays.js'

/** Строка наложения в панели слоёв: подпись, сколько зон, какие уровни, видна ли. */
export interface OverlayRow {
  id: string
  label: string
  count: number
  levels: HazardLevel[]
  visible: boolean
}

/** Заливка зоны — полупрозрачная: под ней читаются подложка и значки слоёв. */
const FILL_OPACITY = 0.22

const overlaySource = (id: string) => `kchs-overlay:${id}`

/**
 * Наложения других фич на карте студии (ADR-0230): поставщики из реестра рисуются
 * невидимыми компонентами и отдают зоны; здесь из них — источники GeoJSON и слои
 * заливки и контура цветом шкалы обстановки из темы карты. Видимость — на сеанс, в
 * спецификацию карты не пишется. Наложение без зон в панели не показывается.
 */
export function useMapOverlays(theme: MapTheme | null): {
  feeds: ReactNode
  rows: OverlayRow[]
  /** Все зоны наложений, в том числе скрытых на карте, — паспорту для плашки обстановки. */
  zones: readonly MapOverlayZone[]
  sources: Record<string, MapSourceSpecification>
  layers: MapLayerSpecification[]
  toggle: (id: string, visible: boolean) => void
} {
  const registered = mapOverlays()
  const [data, setData] = useState<Readonly<Record<string, MapOverlayData | null>>>({})
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())

  // Обратный вызов на поставщика — постоянный, иначе его эффект срабатывал бы на
  // каждую отрисовку карты
  const report = useMemo(
    () =>
      new Map(
        registered.map((overlay) => [
          overlay.id,
          (next: MapOverlayData | null) =>
            setData((current) =>
              current[overlay.id] === next ? current : { ...current, [overlay.id]: next },
            ),
        ]),
      ),
    [registered],
  )

  const feeds = registered.map((overlay) => {
    const onData = report.get(overlay.id)
    return onData ? (
      <Suspense key={overlay.id} fallback={null}>
        <overlay.Feed onData={onData} />
      </Suspense>
    ) : null
  })

  const rows = registered.flatMap((overlay): OverlayRow[] => {
    const current = data[overlay.id]
    if (!current || current.zones.length === 0) return []
    const levels = [...new Set(current.zones.map((zone) => zone.level))].sort((a, b) => a - b)
    return [
      {
        id: overlay.id,
        label: current.label,
        count: current.zones.length,
        levels,
        visible: !hidden.has(overlay.id),
      },
    ]
  })

  const sources = useMemo(() => {
    const out: Record<string, MapSourceSpecification> = {}
    for (const overlay of registered) {
      const current = data[overlay.id]
      if (!current || current.zones.length === 0) continue
      out[overlaySource(overlay.id)] = {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: current.zones.map((zone) => ({
            type: 'Feature',
            properties: { level: zone.level, title: zone.title },
            geometry: zone.geometry,
          })),
        } as never,
      }
    }
    return out
  }, [registered, data])

  const layers = useMemo(() => {
    if (!theme) return []
    // Цвет уровня — из `--hazard-*`; неизвестный уровень — I, как в шкале
    const color = [
      'match',
      ['get', 'level'],
      0,
      theme.hazard[0],
      1,
      theme.hazard[1],
      2,
      theme.hazard[2],
      3,
      theme.hazard[3],
      theme.hazard[1],
    ]
    return registered.flatMap((overlay): MapLayerSpecification[] => {
      const source = overlaySource(overlay.id)
      if (!(source in sources) || hidden.has(overlay.id)) return []
      return [
        {
          id: `${source}:fill`,
          type: 'fill',
          source,
          paint: { 'fill-color': color as never, 'fill-opacity': FILL_OPACITY },
        },
        {
          id: `${source}:line`,
          type: 'line',
          source,
          layout: { 'line-join': 'round' },
          paint: { 'line-color': color as never, 'line-width': 1.5 },
        },
      ]
    })
  }, [registered, sources, hidden, theme])

  const toggle = (id: string, visible: boolean) =>
    setHidden((current) => {
      const next = new Set(current)
      if (visible) next.delete(id)
      else next.add(id)
      return next
    })

  const zones = useMemo(
    () => registered.flatMap((overlay) => data[overlay.id]?.zones ?? []),
    [registered, data],
  )

  return { feeds, rows, zones, sources, layers, toggle }
}
