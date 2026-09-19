import type { MapInstance } from '@kchs/ui'
import {
  type GeoJSONStoreFeatures,
  type HexColor,
  TerraDraw,
  TerraDrawLineStringMode,
  type TerraDrawMouseEvent,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  ValidateNotSelfIntersecting,
} from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { DrawKind, GeometryPart, Position } from './geometry.js'

/**
 * Рисование и правка вершин на карте (07-gis-engine.md §6–7, ADR-0076):
 * terra-draw с адаптером MapLibre — отдельный ленивый чанк студии. Черновик —
 * части одного объекта; цвета — токены темы; привязка к объектам других слоёв —
 * своя функция поверх встроенной привязки к собственным вершинам.
 */

/** Цвета черновика из темы дизайн-системы (`readMapTheme`). */
export interface DrawColors {
  accent: string
  surface: string
  warning: string
}

/** Привязка: координата курсора в пикселях контейнера → точка объекта или ничего. */
export type SnapFunction = (
  point: { x: number; y: number },
  projection: {
    project: (lng: number, lat: number) => { x: number; y: number }
    unproject: (x: number, y: number) => { lng: number; lat: number }
  },
) => Position | null

export type DrawTool = 'select' | DrawKind

export interface DrawController {
  setTool(tool: DrawTool): void
  /** Заменить черновик частями геометрии и выделить первую для правки вершин. */
  load(parts: readonly GeometryPart[]): boolean
  parts(): GeometryPart[]
  clear(): void
  setSnap(snap: SnapFunction | null): void
  /** Стиль подложки сменился — слои черновика пересоздаются. */
  rebuild(): void
  destroy(): void
}

export interface DrawOptions {
  colors: DrawColors
  /** Черновик изменился: нарисована часть, сдвинуты вершины или объект. */
  onChange: (parts: GeometryPart[]) => void
}

/** Точность координат, как у terra-draw по умолчанию: координаты длиннее он не принимает. */
const PRECISION = 9
const round = (value: number) => Number(value.toFixed(PRECISION))

const MODE: Record<GeometryPart['type'], DrawKind> = {
  Point: 'point',
  LineString: 'line',
  Polygon: 'polygon',
}
/** Имена режимов terra-draw по видам рисования. */
const MODE_NAME: Record<DrawKind, string> = {
  point: 'point',
  line: 'linestring',
  polygon: 'polygon',
}
const DRAW_MODES = new Set(Object.values(MODE_NAME))
/** Служебные точки черновика (вершины выделения, середины, замыкание, привязка). */
const GUIDANCE = [
  'selectionPoint',
  'midPoint',
  'closingPoint',
  'snappingPoint',
  'coordinatePoint',
  'currentlyDrawing',
]

function isPart(feature: GeoJSONStoreFeatures): boolean {
  const properties = feature.properties ?? {}
  return (
    DRAW_MODES.has(String(properties.mode)) && !GUIDANCE.some((key) => Boolean(properties[key]))
  )
}

function toPart(feature: GeoJSONStoreFeatures): GeometryPart {
  return JSON.parse(JSON.stringify(feature.geometry)) as GeometryPart
}

function rounded(part: GeometryPart): GeometryPart {
  const at = ([x, y]: Position): Position => [round(x), round(y)]
  switch (part.type) {
    case 'Point':
      return { type: 'Point', coordinates: at(part.coordinates) }
    case 'LineString':
      return { type: 'LineString', coordinates: part.coordinates.map(at) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: part.coordinates.map((ring) => ring.map(at)) }
  }
}

export function createDrawController(map: MapInstance, options: DrawOptions): DrawController {
  const hex = (color: string) => color as HexColor
  const { accent, surface, warning } = options.colors
  let snap: SnapFunction | null = null
  // Черновик заменяют программно (загрузка объекта, координаты): это не правка
  // пользователя — события хранилища terra-draw в это время не сообщаются
  let silent = false

  // Привязка к объектам видимых слоёв; встроенная — к вершинам самого черновика
  const toCustom = (
    event: TerraDrawMouseEvent,
    context: {
      project: (lng: number, lat: number) => { x: number; y: number }
      unproject: (x: number, y: number) => { lng: number; lat: number }
    },
  ) => {
    const found = snap?.({ x: event.containerX, y: event.containerY }, context)
    return found ? [round(found[0]), round(found[1])] : undefined
  }
  const snapping = { toCoordinate: true, toCustom }
  const noSelfIntersections = (feature: GeoJSONStoreFeatures) =>
    ValidateNotSelfIntersecting(feature)

  const closing = {
    closingPointWidth: 5,
    closingPointColor: hex(surface),
    closingPointOutlineColor: hex(accent),
    closingPointOutlineWidth: 2,
    snappingPointWidth: 6,
    snappingPointColor: hex(warning),
    snappingPointOutlineColor: hex(surface),
    snappingPointOutlineWidth: 2,
    coordinatePointWidth: 4,
    coordinatePointColor: hex(surface),
    coordinatePointOutlineColor: hex(accent),
    coordinatePointOutlineWidth: 2,
  }

  const build = (): TerraDraw => {
    const draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, prefixId: 'kchs-edit' }),
      modes: [
        new TerraDrawPointMode({
          styles: {
            pointColor: hex(accent),
            pointWidth: 6,
            pointOutlineColor: hex(surface),
            pointOutlineWidth: 2,
          },
        }),
        new TerraDrawLineStringMode({
          snapping,
          validation: noSelfIntersections,
          styles: { lineStringColor: hex(accent), lineStringWidth: 3, ...closing },
        }),
        new TerraDrawPolygonMode({
          snapping,
          validation: noSelfIntersections,
          styles: {
            fillColor: hex(accent),
            fillOpacity: 0.2,
            outlineColor: hex(accent),
            outlineWidth: 2,
            ...closing,
          },
        }),
        new TerraDrawSelectMode({
          // Черновик остаётся выделенным: щелчок мимо не снимает вершины правки
          allowManualDeselection: false,
          keyEvents: { deselect: null, delete: null, rotate: null, scale: null },
          flags: {
            point: { feature: { draggable: true } },
            linestring: {
              feature: {
                draggable: true,
                validation: noSelfIntersections,
                coordinates: {
                  draggable: true,
                  deletable: true,
                  midpoints: true,
                  snappable: snapping,
                },
              },
            },
            polygon: {
              feature: {
                draggable: true,
                validation: noSelfIntersections,
                coordinates: {
                  draggable: true,
                  deletable: true,
                  midpoints: true,
                  snappable: snapping,
                },
              },
            },
          },
          styles: {
            selectedPointColor: hex(accent),
            selectedPointWidth: 7,
            selectedPointOutlineColor: hex(surface),
            selectedPointOutlineWidth: 2,
            selectedLineStringColor: hex(accent),
            selectedLineStringWidth: 3,
            selectedPolygonColor: hex(accent),
            selectedPolygonFillOpacity: 0.25,
            selectedPolygonOutlineColor: hex(accent),
            selectedPolygonOutlineWidth: 2,
            selectionPointColor: hex(surface),
            selectionPointOutlineColor: hex(accent),
            selectionPointWidth: 5,
            selectionPointOutlineWidth: 2,
            midPointColor: hex(accent),
            midPointOutlineColor: hex(surface),
            midPointWidth: 3,
            midPointOutlineWidth: 1,
          },
        }),
      ],
    })
    draw.start()
    draw.setMode('select')
    draw.on('finish', (id, context) => {
      if (silent) return
      // Нарисована часть — сразу к правке её вершин
      if (context.mode !== 'select' && context.action === 'draw') {
        draw.setMode('select')
        if (draw.hasFeature(id)) draw.selectFeature(id)
      }
      options.onChange(current())
    })
    draw.on('change', (_ids, type) => {
      if (!silent && type === 'delete') options.onChange(current())
    })
    return draw
  }

  let draw = build()
  const current = () => draw.getSnapshot().filter(isPart).map(toPart)

  /** Программная замена черновика — без событий правки. */
  const quietly = <T>(work: () => T): T => {
    silent = true
    try {
      return work()
    } finally {
      silent = false
    }
  }

  const load = (parts: readonly GeometryPart[]): boolean =>
    quietly(() => {
      draw.clear()
      draw.setMode('select')
      if (parts.length === 0) return true
      const results = draw.addFeatures(
        parts.map((part) => ({
          type: 'Feature' as const,
          id: draw.getFeatureId(),
          geometry: rounded(part),
          properties: { mode: MODE_NAME[MODE[part.type]] },
        })),
      )
      const first = results.find((result) => result.valid)
      if (first?.id !== undefined) draw.selectFeature(first.id)
      return results.every((result) => result.valid)
    })

  return {
    setTool(tool) {
      draw.setMode(tool === 'select' ? 'select' : MODE_NAME[tool])
    },
    load,
    parts: current,
    clear() {
      quietly(() => {
        draw.clear()
        draw.setMode('select')
      })
    },
    setSnap(next) {
      snap = next
    },
    rebuild() {
      const parts = current()
      const mode = draw.getMode()
      try {
        draw.stop()
      } catch {
        // Слои черновика уже сняты сменой стиля
      }
      draw = build()
      load(parts)
      if (mode !== 'select') quietly(() => draw.setMode(mode))
    },
    destroy() {
      try {
        draw.stop()
      } catch {
        // Карта уже удалена
      }
    },
  }
}
