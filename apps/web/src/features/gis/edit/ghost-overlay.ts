import type { MapInstance, MapLayerSpecification } from '@kchs/ui'
import { readMapTheme } from '@kchs/ui'
import { useEffect } from 'react'
import type { Ghost } from './edit-store.js'

const SOURCE = 'kchs-edit-ghost'
const LAYERS = [`${SOURCE}:fill`, `${SOURCE}:line`, `${SOURCE}:point`]

function layerSpecs(color: string): MapLayerSpecification[] {
  return [
    {
      id: `${SOURCE}:fill`,
      type: 'fill',
      source: SOURCE,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': color, 'fill-opacity': 0.12 },
    },
    {
      id: `${SOURCE}:line`,
      type: 'line',
      source: SOURCE,
      filter: ['!=', ['geometry-type'], 'Point'],
      paint: { 'line-color': color, 'line-width': 2, 'line-dasharray': [2, 2] },
    },
    {
      id: `${SOURCE}:point`,
      type: 'circle',
      source: SOURCE,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': color,
        'circle-opacity': 0.35,
        'circle-stroke-color': color,
        'circle-stroke-width': 2,
      },
    },
  ]
}

function remove(map: MapInstance): void {
  for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id)
  if (map.getSource(SOURCE)) map.removeSource(SOURCE)
}

/**
 * Геометрия поверх карты пунктиром (ADR-0076): «как было» из истории — цветом
 * второстепенного текста, предложенная правка — цветом предупреждения. Смена
 * подложки снимает слои — они добавляются заново после загрузки стиля.
 */
export function useGhostOverlay(map: MapInstance | null, ghost: Ghost | null): void {
  useEffect(() => {
    if (!map) return
    const draw = () => {
      remove(map)
      if (!ghost) return
      const theme = readMapTheme(map.getContainer())
      const color = ghost.tone === 'previous' ? theme.tokens.neutral : theme.tokens.warning
      map.addSource(SOURCE, {
        type: 'geojson',
        data: { type: 'Feature', geometry: ghost.geometry as never, properties: {} },
      })
      for (const layer of layerSpecs(color)) map.addLayer(layer)
    }
    const redraw = () => {
      try {
        draw()
      } catch {
        // Стиль ещё грузится — повторим по style.load
      }
    }
    redraw()
    map.on('style.load', redraw)
    return () => {
      map.off('style.load', redraw)
      try {
        remove(map)
      } catch {
        // Карта уже удалена
      }
    }
  }, [map, ghost])
}

/** Слои правки: пунктир «как было» и черновик terra-draw (`kchs-edit-*`). */
const EDIT_PREFIX = 'kchs-edit'

/**
 * Слои правки — всегда над слоями данных: карта вставляет слои данных под первые
 * подписи, а без подложки первой «подписью» оказался бы слой меток черновика.
 * Пунктир — под черновиком, чтобы вершины правки оставались сверху.
 */
export function useEditLayersOnTop(map: MapInstance | null, active: boolean): void {
  useEffect(() => {
    if (!map || !active) return
    let frame = 0
    const raise = () => {
      frame = 0
      let ids: string[]
      try {
        ids = map.getStyle().layers.map((layer) => layer.id)
      } catch {
        return
      }
      const edit = ids.filter((id) => id.startsWith(EDIT_PREFIX))
      const wanted = [
        ...edit.filter((id) => id.startsWith(SOURCE)),
        ...edit.filter((id) => !id.startsWith(SOURCE)),
      ]
      const tail = ids.slice(ids.length - wanted.length)
      if (wanted.every((id, index) => tail[index] === id)) return
      for (const id of wanted) map.moveLayer(id)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(raise)
    }
    map.on('styledata', schedule)
    schedule()
    return () => {
      map.off('styledata', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [map, active])
}
