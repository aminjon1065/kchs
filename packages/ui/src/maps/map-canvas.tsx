import type { Bbox, MapCamera } from '@kchs/contracts'
import type { MapImageRequest } from '@kchs/map-style'
import { Compass, Minus, Plus } from 'lucide-react'
import type {
  LayerSpecification,
  MapGeoJSONFeature,
  Map as MapLibreMap,
  SourceSpecification,
  StyleSpecification,
} from 'maplibre-gl'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { IconButton } from '../primitives/button.js'
import { rasterizeMapImage } from './map-icons.js'
import { tilesOnlyChange } from './map-sources.js'

type Runtime = typeof import('./map-runtime.js')
let runtime: Promise<Runtime> | null = null

/** MapLibre грузится один раз и только когда на экране появилась карта. */
function loadRuntime(): Promise<Runtime> {
  runtime ??= import('./map-runtime.js')
  return runtime
}

/** Экземпляр карты MapLibre — для инструментов поверх неё (измерение, рисование, печать). */
export type MapInstance = MapLibreMap

/** Модуль MapLibre — для регистрации протоколов (`addProtocol`) до создания карты. */
export type MapLibreModule = Runtime['maplibregl']

/** Спецификации MapLibre для слоёв и источников данных — без зависимости приложения от MapLibre. */
export type MapLayerSpecification = LayerSpecification
export type MapSourceSpecification = SourceSpecification

/** Объект под курсором: слой MapLibre, источник, идентификатор и свойства. */
export interface MapFeatureHit {
  layerId: string
  source: string
  id: string | number | null
  properties: Record<string, unknown>
  geometry: MapGeoJSONFeature['geometry']
}

export interface MapClickEvent {
  lngLat: [number, number]
  point: [number, number]
  features: MapFeatureHit[]
}

export interface MapCanvasProps {
  /** Стиль подложки (MapLibre v8, как отдал API); null — чистый фон темы. */
  basemapStyle: StyleSpecification | Record<string, unknown> | null
  /** Источники данных: `id → спецификация` (векторные тайлы API, GeoJSON). */
  sources: Readonly<Record<string, SourceSpecification>>
  /** Слои данных снизу вверх — под подписями подложки. */
  layers: readonly LayerSpecification[]
  /** SDF-фигуры и значки, на которые ссылаются слои (`kchs-shape-*`, `kchs-icon-*`). */
  images?: readonly MapImageRequest[]
  /** Начальный вид; смена извне (закладка) — плавный переход. */
  camera: MapCamera
  /** Показать охват: переход к рамке с полями. */
  fitBounds?: { bbox: Bbox; key: string | number } | null
  /** Вид после перемещения (для состояния вкладки и адреса). */
  onCameraChange?: (camera: MapCamera) => void
  /** Слои, объекты которых выбираются щелчком (курсор-«указатель» над ними). */
  interactiveLayerIds?: readonly string[]
  onFeatureClick?: (event: MapClickEvent) => void
  /** Карта готова — для инструментов (измерение, рисование) поверх неё. */
  onMapReady?: (map: MapLibreMap | null) => void
  /**
   * Подготовка MapLibre до создания карты: протоколы источников (`pmtiles://`
   * подложки, ADR-0066). Вызывается один раз на модуль, повторные — ждут первый.
   */
  prepare?: (maplibre: MapLibreModule) => Promise<void>
  /** Выделенные объекты: `feature-state` `selected` у источников. */
  selection?: ReadonlyArray<{ source: string; sourceLayer?: string; id: string | number }>
  /** Только просмотр: без вращения и наклона (плитка дашборда, печать). */
  staticView?: boolean
  /** Элементы поверх карты (панели, легенда) — в том же контексте позиционирования. */
  children?: ReactNode
  className?: string
  'aria-label'?: string
}

/** Поле вокруг охвата при «Показать всё», px. */
const FIT_PADDING = 48

function emptyStyle(background: string): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }],
  }
}

/** Первый слой подписей подложки: данные рисуются под ним (ADR-0066). */
function beforeLayerId(map: MapLibreMap): string | undefined {
  const style = map.getStyle()
  const marked = (style.metadata as Record<string, unknown> | undefined)?.['kchs:firstSymbolLayer']
  if (typeof marked === 'string' && map.getLayer(marked)) return marked
  return style.layers.find((layer) => layer.type === 'symbol' && !isDataLayer(layer.id))?.id
}

/** Слои и источники данных помечаются префиксом — их не путать со слоями подложки. */
const DATA_PREFIX = 'kchs-data:'
const isDataLayer = (id: string) => id.startsWith(DATA_PREFIX)
const dataId = (id: string) => `${DATA_PREFIX}${id}`
const plainId = (id: string) => id.slice(DATA_PREFIX.length)

const cameraOf = (map: MapLibreMap): MapCamera => {
  const center = map.getCenter()
  return {
    center: [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))],
    zoom: Number(map.getZoom().toFixed(2)),
    bearing: Number(map.getBearing().toFixed(1)),
    pitch: Number(map.getPitch().toFixed(1)),
  }
}

const sameCamera = (a: MapCamera, b: MapCamera) =>
  Math.abs(a.center[0] - b.center[0]) < 1e-6 &&
  Math.abs(a.center[1] - b.center[1]) < 1e-6 &&
  Math.abs(a.zoom - b.zoom) < 0.01 &&
  Math.abs((a.bearing ?? 0) - (b.bearing ?? 0)) < 0.1 &&
  Math.abs((a.pitch ?? 0) - (b.pitch ?? 0)) < 0.1

/**
 * Карта дизайн-системы (07-gis-engine.md §6, ADR-0072): MapLibre GL с подложкой
 * из реестра, слоями данных от компилятора стилей `@kchs/map-style`, SDF-значками
 * и элементами управления дизайн-системы. Атрибуция подложки видна всегда —
 * этого требуют лицензии OpenStreetMap и OpenMapTiles. Атрибут `data-map-state`
 * (`loading` | `idle` | `failed`) — готовность кадра для печати, снимков и тестов:
 * `idle` — тайлы загружены и нарисованы, переходы закончены.
 */
export function MapCanvas({
  basemapStyle,
  sources,
  layers,
  images = [],
  camera,
  fitBounds,
  onCameraChange,
  interactiveLayerIds = [],
  onFeatureClick,
  onMapReady,
  prepare,
  selection = [],
  staticView = false,
  children,
  className,
  'aria-label': ariaLabel,
}: MapCanvasProps) {
  const t = useUiT()
  const container = useRef<HTMLElement>(null)
  const [map, setMap] = useState<MapLibreMap | null>(null)
  // Номер загруженного стиля: слои данных добавляются после `style.load` —
  // `isStyleLoaded()` ждёт ещё и все источники, а подложка может грузиться долго
  const [styleReady, setStyleReady] = useState(0)
  const styleLoaded = useRef(false)
  const [failed, setFailed] = useState(false)
  // Готовность кадра для печати и снимков: `idle` MapLibre (тайлы загружены и
  // нарисованы) после того, как слои данных текущих пропсов добавлены на карту
  const [ready, setReady] = useState(false)
  const [synced, setSynced] = useState(false)
  // Подложка, уже поставленная на карту: карта создаётся с пустым стилем (null)
  const appliedBasemap = useRef<MapCanvasProps['basemapStyle']>(null)
  const latest = useRef({ onCameraChange, onFeatureClick, interactiveLayerIds, camera })
  latest.current = { onCameraChange, onFeatureClick, interactiveLayerIds, camera }
  const registered = useRef(new Set<string>())
  // Что уже применено к карте: MapLibre нормализует спецификации, поэтому
  // сравнение идёт с последним применённым, а не со стилем карты
  const applied = useRef({ sources: new Map<string, string>(), layers: new Map<string, string>() })

  // ─── Создание карты ────────────────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: карта создаётся один раз; вид, стиль и слои синхронизируют эффекты ниже
  useEffect(() => {
    let disposed = false
    let instance: MapLibreMap | null = null
    let observer: ResizeObserver | null = null
    const start = async () => {
      let lib: Runtime
      try {
        lib = await loadRuntime()
        await prepare?.(lib.maplibregl)
      } catch {
        if (!disposed) setFailed(true)
        return
      }
      const element = container.current
      if (disposed || !element) return
      const background = getComputedStyle(element).getPropertyValue('--bg-canvas').trim() || '#fff'
      const initial = latest.current.camera
      instance = new lib.maplibregl.Map({
        container: element,
        style: emptyStyle(background),
        center: initial.center,
        zoom: initial.zoom,
        bearing: initial.bearing ?? 0,
        pitch: initial.pitch ?? 0,
        attributionControl: { compact: true },
        dragRotate: !staticView,
        pitchWithRotate: !staticView,
        touchPitch: !staticView,
        // Подписи и значки — в разрешении экрана; холст не пересоздаётся при смене вкладки
        pixelRatio: window.devicePixelRatio,
        cooperativeGestures: false,
        fadeDuration: 150,
        // Подписи элементов MapLibre — на языке интерфейса
        locale: {
          'Map.Title': t('ui.map.label'),
          'AttributionControl.ToggleAttribution': t('ui.map.attribution'),
          'ScaleControl.Meters': t('ui.map.meters'),
          'ScaleControl.Kilometers': t('ui.map.kilometers'),
          'Popup.Close': t('ui.map.closePopup'),
        },
      })
      instance.addControl(new lib.maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
      instance.on('moveend', () => {
        if (!instance) return
        const next = cameraOf(instance)
        if (!sameCamera(next, latest.current.camera)) latest.current.onCameraChange?.(next)
      })
      instance.on('click', (event) => {
        const handler = latest.current.onFeatureClick
        if (!handler || !instance) return
        const ids = latest.current.interactiveLayerIds
          .map(dataId)
          .filter((id) => instance?.getLayer(id))
        const hits = ids.length
          ? instance.queryRenderedFeatures(event.point, { layers: ids })
          : ([] as MapGeoJSONFeature[])
        handler({
          lngLat: [event.lngLat.lng, event.lngLat.lat],
          point: [event.point.x, event.point.y],
          features: hits.map((feature) => ({
            layerId: plainId(feature.layer.id),
            source: plainId(feature.source),
            id: feature.id ?? null,
            properties: feature.properties ?? {},
            geometry: feature.geometry,
          })),
        })
      })
      instance.on('mousemove', (event) => {
        if (!instance) return
        const ids = latest.current.interactiveLayerIds
          .map(dataId)
          .filter((id) => instance?.getLayer(id))
        const over =
          ids.length > 0 && instance.queryRenderedFeatures(event.point, { layers: ids }).length > 0
        instance.getCanvas().style.cursor = over ? 'pointer' : ''
      })
      // Значок, которого не было в списке (правка стиля на лету), — дорисовать
      instance.on('styleimagemissing', (event) => {
        const id = event.id
        if (!instance || !id.startsWith('kchs-') || registered.current.has(id)) return
        const [, kind, ...rest] = id.split('-')
        if (kind !== 'shape' && kind !== 'icon') return
        void addImage(instance, { id, kind, name: rest.join('-'), sdf: true }, registered.current)
      })
      instance.on('idle', () => setReady(true))
      instance.on('dataloading', () => setReady(false))
      instance.on('movestart', () => setReady(false))
      instance.on('style.load', () => {
        styleLoaded.current = true
        setStyleReady((n) => n + 1)
      })
      // Тайл, не отданный сервером (нет доступа, тайм-аут), — не повод ронять карту:
      // свой обработчик вместо вывода MapLibre в консоль; студия знает о доступе из слоя
      instance.on('error', () => undefined)
      observer = new ResizeObserver(() => instance?.resize())
      observer.observe(element)
      setMap(instance)
      onMapReady?.(instance)
    }
    void start()
    return () => {
      disposed = true
      observer?.disconnect()
      onMapReady?.(null)
      instance?.remove()
      registered.current.clear()
      applied.current.sources.clear()
      applied.current.layers.clear()
      appliedBasemap.current = null
    }
  }, [])

  // ─── Подложка ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || appliedBasemap.current === basemapStyle) return
    appliedBasemap.current = basemapStyle
    const element = container.current
    const background = element
      ? getComputedStyle(element).getPropertyValue('--bg-canvas').trim() || '#fff'
      : '#fff'
    const next = (basemapStyle as StyleSpecification | null) ?? emptyStyle(background)
    // Слои данных переносятся в новый стиль: смена подложки не теряет данные
    styleLoaded.current = false
    map.setStyle(next, {
      transformStyle: (previous, style) => {
        if (!previous) return style
        const dataSources = Object.fromEntries(
          Object.entries(previous.sources).filter(([id]) => isDataLayer(id)),
        )
        const dataLayers = previous.layers.filter((layer) => isDataLayer(layer.id))
        return {
          ...style,
          sources: { ...style.sources, ...dataSources },
          layers: [...style.layers, ...dataLayers],
        }
      },
    })
    registered.current.clear()
  }, [map, basemapStyle])

  // ─── Источники, изображения и слои данных ──────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleReady — сигнал загрузки стиля (подложка сменилась)
  useEffect(() => {
    if (!map || !styleLoaded.current) return
    let cancelled = false
    setSynced(false)
    const sync = async () => {
      const ratio = window.devicePixelRatio || 1
      await Promise.all(
        images
          .filter((image) => !registered.current.has(image.id) && !map.hasImage(image.id))
          .map((image) => addImage(map, image, registered.current, ratio)),
      )
      if (cancelled || !styleLoaded.current) return
      const state = applied.current
      const wantedSources = new Map(
        Object.entries(sources).map(([id, source]) => [dataId(id), JSON.stringify(source)]),
      )
      const wantedLayers = new Map(layers.map((layer) => [dataId(layer.id), layer]))
      // Источники слоёв, которые добавляются заново (новые или изменённые): такой
      // источник MapLibre до конца кадра приостанавливает и потом лишь перекладывает
      // прежние тайлы — новый адрес из `setTiles` он бы не загрузил
      const relaidSources = new Set<string>()
      for (const layer of layers) {
        const id = dataId(layer.id)
        if (map.getLayer(id) && state.layers.get(id) === JSON.stringify(layer)) continue
        if ('source' in layer && typeof layer.source === 'string') {
          relaidSources.add(dataId(layer.source))
        }
      }
      const changedSources = new Set<string>()
      for (const [id, json] of wantedSources) {
        const existing = map.getSource(id)
        const previous = state.sources.get(id)
        if (!existing || previous === json) continue
        // Сменился только адрес тайлов (время, фильтр), слои те же: источник
        // перечитывает тайлы, прежние видны до прихода новых — кадры не мигают.
        // Пока тайлы источника грузятся, MapLibre перечитал бы их по старому
        // адресу, а слои источника добавляются заново (стиль сменил поля тайлов) —
        // новых не загрузил бы: тогда источник пересоздаётся
        const tiles = tilesOnlyChange(previous, json)
        if (
          tiles &&
          !relaidSources.has(id) &&
          'setTiles' in existing &&
          typeof existing.setTiles === 'function' &&
          map.isSourceLoaded(id)
        ) {
          existing.setTiles(tiles)
          state.sources.set(id, json)
          continue
        }
        changedSources.add(id)
      }
      // Лишние и изменённые слои, слои изменённых источников — снять
      for (const layer of map.getStyle().layers) {
        if (!isDataLayer(layer.id)) continue
        const wanted = wantedLayers.get(layer.id)
        const source = 'source' in layer ? layer.source : undefined
        if (
          !wanted ||
          state.layers.get(layer.id) !== JSON.stringify(wanted) ||
          (source !== undefined && changedSources.has(source))
        ) {
          map.removeLayer(layer.id)
          state.layers.delete(layer.id)
        }
      }
      for (const id of Object.keys(map.getStyle().sources)) {
        if (!isDataLayer(id)) continue
        if (!wantedSources.has(id) || changedSources.has(id)) {
          map.removeSource(id)
          state.sources.delete(id)
        }
      }
      for (const [id, json] of wantedSources) {
        if (map.getSource(id)) continue
        map.addSource(id, JSON.parse(json) as SourceSpecification)
        state.sources.set(id, json)
      }
      const before = beforeLayerId(map)
      for (const layer of layers) {
        const id = dataId(layer.id)
        if (map.getLayer(id)) {
          map.moveLayer(id, before)
          continue
        }
        const source =
          'source' in layer && typeof layer.source === 'string' ? dataId(layer.source) : undefined
        map.addLayer({ ...layer, id, ...(source ? { source } : {}) } as LayerSpecification, before)
        state.layers.set(id, JSON.stringify(layer))
      }
      setSynced(true)
    }
    void sync()
    return () => {
      cancelled = true
    }
  }, [map, styleReady, sources, layers, images])

  // ─── Выделение ─────────────────────────────────────────────────────────────
  const shown = useRef<typeof selection>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: styleReady — сигнал загрузки стиля (подложка сменилась)
  useEffect(() => {
    if (!map || !styleLoaded.current) return
    for (const item of shown.current) {
      const source = dataId(item.source)
      if (map.getSource(source)) {
        map.setFeatureState(
          { source, sourceLayer: item.sourceLayer, id: item.id },
          { selected: false },
        )
      }
    }
    for (const item of selection) {
      const source = dataId(item.source)
      if (map.getSource(source)) {
        map.setFeatureState(
          { source, sourceLayer: item.sourceLayer, id: item.id },
          { selected: true },
        )
      }
    }
    shown.current = selection
  }, [map, styleReady, selection])

  // ─── Вид извне и «Показать всё» ────────────────────────────────────────────
  useEffect(() => {
    if (!map) return
    if (!sameCamera(cameraOf(map), camera)) {
      map.easeTo({
        center: camera.center,
        zoom: camera.zoom,
        bearing: camera.bearing ?? 0,
        pitch: camera.pitch ?? 0,
        duration: prefersReducedMotion() ? 0 : 400,
      })
    }
  }, [map, camera])

  useEffect(() => {
    if (!map || !fitBounds) return
    const [west, south, east, north] = fitBounds.bbox
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: FIT_PADDING, maxZoom: 14, duration: prefersReducedMotion() ? 0 : 400 },
    )
  }, [map, fitBounds])

  return (
    <div
      className={cn('kchs-map relative isolate min-h-0 overflow-hidden bg-canvas', className)}
      data-map-state={failed ? 'failed' : ready && synced ? 'idle' : 'loading'}
    >
      {/* MapLibre ставит контейнеру `position: relative` — размер задаёт обёртка */}
      <div className="absolute inset-0">
        <section
          ref={container}
          className="h-full w-full"
          aria-label={ariaLabel ?? t('ui.map.label')}
        />
      </div>
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-sm text-fg-muted">
          {t('ui.map.loadFailed')}
        </p>
      ) : null}
      {map ? (
        <div className="absolute right-2 top-2 z-10 flex flex-col gap-1 rounded-md border border-line bg-surface p-0.5 shadow-sm">
          <IconButton label={t('ui.map.zoomIn')} size="sm" onClick={() => map.zoomIn()}>
            <Plus className="size-4" aria-hidden />
          </IconButton>
          <IconButton label={t('ui.map.zoomOut')} size="sm" onClick={() => map.zoomOut()}>
            <Minus className="size-4" aria-hidden />
          </IconButton>
          {staticView ? null : (
            <IconButton
              label={t('ui.map.resetNorth')}
              size="sm"
              onClick={() => map.easeTo({ bearing: 0, pitch: 0 })}
            >
              <Compass className="size-4" aria-hidden />
            </IconButton>
          )}
        </div>
      ) : null}
      {children}
    </div>
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

async function addImage(
  map: MapLibreMap,
  request: MapImageRequest,
  registered: Set<string>,
  ratio = window.devicePixelRatio || 1,
): Promise<void> {
  registered.add(request.id)
  try {
    const image = await rasterizeMapImage(request, ratio)
    if (!map.hasImage(request.id)) {
      map.addImage(request.id, image, { sdf: true, pixelRatio: ratio })
    }
  } catch {
    registered.delete(request.id)
  }
}
