import type { Bbox, LayerFeatureCollection } from '@kchs/contracts'
import type { MapInstance } from '@kchs/ui'
import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LINKED_SELECTION_LIMIT } from '~/app/workspace/view-context.js'
import { http } from '~/shared/api/client.js'
import { type FeatureRef, useStudio } from './context.js'
import { featuresQuery, mergeRefs, pickableLayerIds, refsOfHits } from './map-features.js'

/** Меньше — это щелчок, а не рамка, px. */
const CLICK_SLOP = 4

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Охват WGS 84 рамки экрана: углы — с учётом поворота карты. */
function boxBounds(map: MapInstance, box: Box): Bbox {
  const corners = [
    map.unproject([box.x0, box.y0]),
    map.unproject([box.x1, box.y0]),
    map.unproject([box.x1, box.y1]),
    map.unproject([box.x0, box.y1]),
  ]
  const lons = corners.map((corner) => corner.lng)
  const lats = corners.map((corner) => corner.lat)
  return [
    Math.max(-180, Math.min(...lons)),
    Math.max(-90, Math.min(...lats)),
    Math.min(180, Math.max(...lons)),
    Math.min(90, Math.max(...lats)),
  ]
}

/**
 * Выделение рамкой (P2-E02 S02, ADR-0073): в режиме «Рамка» — перетаскивание
 * и щелчок, в обычном — Shift+перетаскивание (масштаб рамкой MapLibre
 * отключён), ⌘/Ctrl — добавить к выделению. Объекты — `queryRenderedFeatures`
 * видимых слоёв; для скоплений и тепловых карт (отдельных объектов на экране
 * нет) — объекты слоя в охвате рамки с сервера, с фильтром и временем карты.
 */
export function BoxSelect({
  selectInViewRef,
}: {
  /** «Выделить всё в охвате» — то же без мыши (клавиатура, скринридер). */
  selectInViewRef: MutableRefObject<(() => void) | null>
}) {
  const studio = useStudio()
  const map = studio.map
  const [box, setBox] = useState<Box | null>(null)
  const latest = useRef(studio)
  latest.current = studio

  useEffect(() => {
    if (!map) return
    map.boxZoom.disable()
    const container = map.getCanvasContainer()

    /** Щелчок в режиме «Рамка»: верхний объект под курсором; ⌘/Ctrl — переключить его. */
    const pick = (point: { x: number; y: number }, add: boolean) => {
      const current = latest.current
      const layers = pickableLayerIds(map)
      const hits = layers.length
        ? map.queryRenderedFeatures(
            [
              [point.x - CLICK_SLOP, point.y - CLICK_SLOP],
              [point.x + CLICK_SLOP, point.y + CLICK_SLOP],
            ],
            { layers },
          )
        : []
      const [ref] = refsOfHits(hits).refs
      let next: FeatureRef[]
      if (!ref) next = add ? [...current.selection] : []
      else if (!add) next = [ref]
      else {
        const selected = current.selection.some(
          (item) => item.layerId === ref.layerId && item.rowId === ref.rowId,
        )
        next = selected
          ? current.selection.filter(
              (item) => !(item.layerId === ref.layerId && item.rowId === ref.rowId),
            )
          : mergeRefs(current.selection, [ref], true, LINKED_SELECTION_LIMIT)
      }
      current.setSelection(next)
      if (ref) current.setActiveLayerId(ref.layerId)
    }

    const select = async (area: Box, add: boolean) => {
      const current = latest.current
      const layers = pickableLayerIds(map)
      if (layers.length === 0) return
      const hits = map.queryRenderedFeatures(
        [
          [Math.min(area.x0, area.x1), Math.min(area.y0, area.y1)],
          [Math.max(area.x0, area.x1), Math.max(area.y0, area.y1)],
        ],
        { layers },
      )
      const { refs, clustered } = refsOfHits(hits)
      // Тепловая карта и скопления: объектов на экране нет — берём их у сервера
      const server = new Set(clustered)
      for (const item of current.layers) {
        if (item.entry.visible && item.layer?.dataAccess) {
          if (item.layer.style.renderer.kind === 'heatmap') server.add(item.layer.id)
        }
      }
      const fetched: FeatureRef[] = []
      if (server.size > 0) {
        const bbox = boxBounds(map, area)
        await Promise.all(
          [...server].map(async (layerId) => {
            try {
              const collection = await http.get<LayerFeatureCollection>(
                `/gis/layers/${layerId}/features`,
                {
                  query: featuresQuery(
                    {
                      bbox,
                      filter: current.layerFilters[layerId] ?? null,
                      time: current.spec.time,
                    },
                    LINKED_SELECTION_LIMIT,
                  ),
                },
              )
              for (const feature of collection.features) {
                fetched.push({ layerId, rowId: feature.id })
              }
            } catch {
              // Слой недоступен — выделяется то, что видно
            }
          }),
        )
      }
      // Выделение — с учётом того, что изменилось, пока шёл запрос к серверу
      const latestStudio = latest.current
      const next = mergeRefs(
        latestStudio.selection,
        [...refs, ...fetched],
        add,
        LINKED_SELECTION_LIMIT,
      )
      latestStudio.setSelection(next)
      const first = next[0]
      if (first && !add) latestStudio.setActiveLayerId(first.layerId)
    }

    /** Щелчок, которым браузер завершает перетаскивание, до карты не доходит. */
    const swallowClick = () => {
      const swallow = (event: MouseEvent) => {
        event.stopPropagation()
        event.preventDefault()
      }
      container.addEventListener('click', swallow, { capture: true, once: true })
      // Кнопку отпустили вне карты — щелчка не будет, следующий настоящий не глотаем
      setTimeout(() => container.removeEventListener('click', swallow, { capture: true }), 0)
    }

    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      const tool = latest.current.tool
      const boxing = tool === 'select' || (event.shiftKey && tool === null)
      if (!boxing) return
      // Раньше обработчиков MapLibre: рамка вместо сдвига карты
      event.preventDefault()
      event.stopPropagation()
      // Размер — у контейнера карты: у контейнера холста высота нулевая (холст — absolute)
      const rect = map.getContainer().getBoundingClientRect()
      const start = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const add = event.metaKey || event.ctrlKey
      let current: Box = { x0: start.x, y0: start.y, x1: start.x, y1: start.y }
      const onMove = (move: MouseEvent) => {
        current = {
          ...current,
          x1: Math.max(0, Math.min(rect.width, move.clientX - rect.left)),
          y1: Math.max(0, Math.min(rect.height, move.clientY - rect.top)),
        }
        setBox(current)
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setBox(null)
        const dragged =
          Math.abs(current.x1 - current.x0) > CLICK_SLOP ||
          Math.abs(current.y1 - current.y0) > CLICK_SLOP
        if (dragged) {
          // Браузер завершит рамку щелчком: карта приняла бы его за щелчок мимо
          // объектов и сняла бы только что сделанное выделение
          swallowClick()
          void select(current, add)
        }
        // Щелчок в режиме «Рамка» — объект под курсором; в обычном — обычный щелчок карты
        else if (tool === 'select') pick(start, add)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    container.addEventListener('mousedown', onDown, true)
    selectInViewRef.current = () => {
      const { width, height } = map.getContainer().getBoundingClientRect()
      void select({ x0: 0, y0: 0, x1: width, y1: height }, false)
    }
    return () => {
      selectInViewRef.current = null
      container.removeEventListener('mousedown', onDown, true)
      try {
        map.boxZoom.enable()
      } catch {
        // Карта уже удалена
      }
    }
  }, [map, selectInViewRef])

  if (!map || !box) return null
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 rounded-xs border border-accent bg-accent/10"
      style={{
        left: Math.min(box.x0, box.x1),
        top: Math.min(box.y0, box.y1),
        width: Math.abs(box.x1 - box.x0),
        height: Math.abs(box.y1 - box.y0),
      }}
    />,
    map.getContainer(),
  )
}
