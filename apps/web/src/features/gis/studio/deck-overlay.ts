import type { MapInstance, MapLayerSpecification } from '@kchs/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FeatureRef } from './context.js'
import type { DeckColor, FeatureProps } from './deck-roles.js'
import type { DeckPaint } from './deck-style.js'

/**
 * Слой deck.gl поверх MapLibre для больших наборов (07-gis-engine.md §15,
 * ADR-0110). Данные — те же векторные тайлы, что у MapLibre: политики строк
 * применяет сервер, клиент их не обходит. Пакет грузится по требованию —
 * пока порог не превышен, deck.gl в основной бандл не попадает.
 *
 * Выбор объекта остаётся у одного обработчика: щелчок по карте сначала
 * спрашивает MapLibre, а если там ничего нет — оверлей deck.gl (`pickObject`).
 * Второго обработчика щелчка нет, поэтому нет и гонки за выделение.
 *
 * Карта остаётся рабочей без WebGL2 и при любой ошибке deck.gl: слои тогда
 * рисует MapLibre, как раньше.
 */

/** Слой, отданный deck.gl. */
export interface DeckEntry {
  layerId: string
  /** Адрес тайлов — тот же, что у источника MapLibre. */
  tileUrl: string
  /** Слои скомпилированного стиля: из них берутся цвета и размеры. */
  style: readonly MapLayerSpecification[]
  /** Тайлы крупнее не запрашиваются. */
  maxZoom: number
}

export type DeckStatus = 'off' | 'loading' | 'ready' | 'failed'

/** Щелчок по карте мимо слоёв MapLibre: что под ним у deck.gl. */
export type DeckPicker = (point: [number, number]) => FeatureRef | null

interface DeckModules {
  MapboxOverlay: new (props: Record<string, unknown>) => DeckOverlayInstance
  MVTLayer: new (props: Record<string, unknown>) => unknown
  deckPaint: (layers: readonly MapLayerSpecification[]) => DeckPaint | null
}

interface PickInfo {
  object?: PickedFeature
  layer?: { id?: string; root?: { id?: string } } | null
}

interface DeckOverlayInstance {
  setProps: (props: Record<string, unknown>) => void
  pickObject?: (options: { x: number; y: number; radius?: number }) => PickInfo | null
  finalize?: () => void
}

interface PickedFeature {
  id?: string | number
  properties?: FeatureProps
}

let modules: Promise<DeckModules> | null = null

/** deck.gl и мост стилей — отдельный кусок сборки, грузится при первом слое. */
async function loadDeck(): Promise<DeckModules> {
  modules ??= (async () => {
    const style = await import('./deck-style.js')
    const overlay = await import('@deck.gl/mapbox')
    const layers = await import('@deck.gl/geo-layers')
    return {
      MapboxOverlay: overlay.MapboxOverlay,
      MVTLayer: layers.MVTLayer,
      deckPaint: style.deckPaint,
    } as unknown as DeckModules
  })()
  return modules
}

/** WebGL2 в браузере: без него deck.gl не запускается, карта остаётся на MapLibre. */
export function webgl2Available(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
}

const DECK_PREFIX = 'kchs-deck:'
/** Выделенный объект — толще обводка. */
const SELECTED_WIDTH = 3
/** Допуск попадания щелчка, пикселей. */
const PICK_RADIUS = 6

/** Слой подложки, перед которым вставляются данные: под подписями базовой карты. */
function beforeLayerId(map: MapInstance): string | undefined {
  try {
    const style = map.getStyle()
    const marker = (style.metadata as Record<string, unknown> | undefined)?.[
      'kchs:firstSymbolLayer'
    ]
    if (typeof marker === 'string' && map.getLayer(marker)) return marker
    return style.layers?.find(
      (layer) => layer.type === 'symbol' && !layer.id.startsWith(DECK_PREFIX),
    )?.id
  } catch {
    return undefined
  }
}

function featureId(feature: PickedFeature): string | null {
  const raw = feature.id ?? feature.properties?._id
  return raw === undefined || raw === null ? null : String(raw)
}

/**
 * Готовность deck.gl: `off` — порог не превышен, `loading` — пакет грузится,
 * `ready` — слои можно отдавать, `failed` — рисует MapLibre.
 */
export function useDeckSupport(needed: boolean): DeckStatus {
  const [status, setStatus] = useState<DeckStatus>('off')
  useEffect(() => {
    if (!needed) {
      setStatus('off')
      return
    }
    if (!webgl2Available()) {
      setStatus('failed')
      return
    }
    let alive = true
    setStatus('loading')
    loadDeck().then(
      () => {
        if (alive) setStatus('ready')
      },
      () => {
        if (alive) setStatus('failed')
      },
    )
    return () => {
      alive = false
    }
  }, [needed])
  return status
}

export interface DeckOverlayOptions {
  selection: readonly FeatureRef[]
  /** Цвет выделения из темы карты — тот же, что у слоёв подсветки MapLibre. */
  selectedColor: DeckColor
  /** Отвалился deck.gl — вызывающий возвращает слои MapLibre. */
  onFailed: () => void
}

/**
 * Держит `MapboxOverlay` на живой карте и пересобирает слои при смене данных,
 * стиля или выделения. Смена подложки (`setStyle`) оверлей не трогает: он
 * добавлен контролом карты, а не слоем стиля. Возвращает выбор объекта под
 * точкой экрана.
 */
export function useDeckOverlay(
  map: MapInstance | null,
  entries: readonly DeckEntry[],
  enabled: boolean,
  options: DeckOverlayOptions,
): DeckPicker {
  const overlay = useRef<DeckOverlayInstance | null>(null)
  const layerIds = useRef<readonly string[]>([])
  const latest = useRef(options)
  latest.current = options
  const [ready, setReady] = useState(false)
  layerIds.current = entries.map((entry) => entry.layerId)

  useEffect(() => {
    if (!map || !enabled) return
    let alive = true
    let created: DeckOverlayInstance | null = null
    loadDeck()
      .then(({ MapboxOverlay }) => {
        if (!alive) return
        created = new MapboxOverlay({ interleaved: true, layers: [] })
        overlay.current = created
        ;(map as unknown as { addControl: (control: unknown) => void }).addControl(created)
        setReady(true)
      })
      .catch(() => {
        if (alive) latest.current.onFailed()
      })
    return () => {
      alive = false
      setReady(false)
      overlay.current = null
      if (!created) return
      try {
        ;(map as unknown as { removeControl: (control: unknown) => void }).removeControl(created)
      } catch {
        // Карта уже удалена
      }
      created.finalize?.()
    }
  }, [map, enabled])

  // biome-ignore lint/correctness/useExhaustiveDependencies: цвет и сбой берутся из latest
  useEffect(() => {
    const instance = overlay.current
    if (!map || !instance || !ready) return
    let cancelled = false
    loadDeck()
      .then(({ MVTLayer, deckPaint }) => {
        if (cancelled) return
        const before = beforeLayerId(map)
        const selected = new Set(
          latest.current.selection.map((ref) => `${ref.layerId}:${ref.rowId}`),
        )
        instance.setProps({
          layers: entries.flatMap((entry) => {
            const paint = deckPaint(entry.style)
            return paint
              ? [
                  buildLayer(
                    MVTLayer,
                    map,
                    entry,
                    paint,
                    selected,
                    before,
                    () => latest.current.selectedColor,
                  ),
                ]
              : []
          }),
        })
      })
      .catch(() => latest.current.onFailed())
    return () => {
      cancelled = true
    }
  }, [map, ready, entries, options.selection])

  return useCallback((point) => {
    const instance = overlay.current
    if (!instance?.pickObject) return null
    let info: PickInfo | null = null
    try {
      info = instance.pickObject({ x: point[0], y: point[1], radius: PICK_RADIUS })
    } catch {
      return null
    }
    if (!info?.object) return null
    const rowId = featureId(info.object)
    const pickedId = info.layer?.root?.id ?? info.layer?.id ?? ''
    const layerId = layerIds.current.find((id) => pickedId.startsWith(`${DECK_PREFIX}${id}`))
    return rowId !== null && layerId ? { layerId, rowId } : null
  }, [])
}

function buildLayer(
  MVTLayer: DeckModules['MVTLayer'],
  map: MapInstance,
  entry: DeckEntry,
  paint: DeckPaint,
  selected: ReadonlySet<string>,
  beforeId: string | undefined,
  selectedColor: () => DeckColor,
): unknown {
  const zoom = () => {
    try {
      return map.getZoom()
    } catch {
      return 0
    }
  }
  const props = (feature: PickedFeature): FeatureProps => feature.properties ?? {}
  const isSelected = (feature: PickedFeature) => {
    const id = featureId(feature)
    return id !== null && selected.has(`${entry.layerId}:${id}`)
  }
  const hidden: DeckColor = [0, 0, 0, 0]
  const marks = [entry.tileUrl, [...selected].join(',')]

  return new MVTLayer({
    id: `${DECK_PREFIX}${entry.layerId}`,
    data: entry.tileUrl,
    minZoom: 0,
    maxZoom: entry.maxZoom,
    uniqueIdProperty: '_id',
    pickable: true,
    binary: true,
    beforeId,
    stroked: true,
    filled: paint.kind !== 'line',
    pointRadiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 1,
    getFillColor: (feature: PickedFeature) =>
      paint.visible(props(feature), zoom()) ? paint.fillColor(props(feature), zoom()) : hidden,
    getLineColor: (feature: PickedFeature) => {
      if (!paint.visible(props(feature), zoom())) return hidden
      return isSelected(feature) ? selectedColor() : paint.lineColor(props(feature), zoom())
    },
    getPointRadius: (feature: PickedFeature) => paint.radius(props(feature), zoom()),
    getLineWidth: (feature: PickedFeature) =>
      isSelected(feature) ? SELECTED_WIDTH : paint.lineWidth(props(feature), zoom()),
    updateTriggers: {
      getFillColor: marks,
      getLineColor: marks,
      getPointRadius: [entry.tileUrl],
      getLineWidth: marks,
    },
  })
}
