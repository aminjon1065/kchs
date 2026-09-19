import type { MapCamera } from '@kchs/contracts'
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'

export interface MapSnapshotOptions {
  /** Размер кадра в логических пикселях (CSS). */
  width: number
  height: number
  /** Плотность кадра: пикселей холста на логический пиксель (печать 150 dpi — 1,5625). */
  pixelRatio: number
  /** Вид кадра; по умолчанию — вид карты. */
  camera?: MapCamera
  /** Сколько ждать загрузки тайлов, мс: дальше кадр снимается как есть. */
  timeout?: number
}

export interface MapSnapshot {
  /** Холст кадра: `width × pixelRatio` на `height × pixelRatio`. */
  canvas: HTMLCanvasElement
  /** Тайлы загружены и нарисованы до тайм-аута. */
  complete: boolean
  /** Метров на логический пиксель по горизонтали в центре кадра — масштабная линейка. */
  metersPerPixel: number
  /** Поворот кадра, градусы: стрелка севера. */
  bearing: number
  /** Атрибуция источников стиля — текстом, без разметки, без повторов. */
  attribution: string[]
}

/** Кадр больше не снимается: ограничение холста WebGL (как `maxCanvasSize` MapLibre). */
const MAX_CANVAS = 4096
const DEFAULT_TIMEOUT = 20_000
const EARTH_RADIUS = 6_371_008.8

function haversine([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Атрибуция источника MapLibre — HTML (ссылки): для печати нужен текст. */
function attributionText(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function styleAttribution(style: StyleSpecification): string[] {
  const out: string[] = []
  for (const source of Object.values(style.sources)) {
    const html = 'attribution' in source ? source.attribution : undefined
    if (typeof html !== 'string' || !html.trim()) continue
    const text = attributionText(html)
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

/**
 * Снимок карты для печати и выгрузки (07-gis-engine.md §13, ADR-0074): вторая
 * карта MapLibre вне экрана с `preserveDrawingBuffer` — тот же стиль (подложка,
 * слои данных, SDF-значки с исходной карты), вид и размер кадра печати. Ждёт
 * загрузки тайлов (`idle`, не дольше `timeout`) и отдаёт холст; живая карта на
 * экране не меняется, её холст читать не нужно.
 */
export async function snapshotMap(
  source: MapLibreMap,
  options: MapSnapshotOptions,
): Promise<MapSnapshot> {
  const { maplibregl } = await import('./map-runtime.js')
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))
  // Холст не больше предела WebGL: плотность снижается, размер кадра — тот же
  const pixelRatio = Math.min(options.pixelRatio, MAX_CANVAS / width, MAX_CANVAS / height)
  const center = source.getCenter()
  const camera = options.camera ?? {
    center: [center.lng, center.lat] as [number, number],
    zoom: source.getZoom(),
    bearing: source.getBearing(),
    pitch: source.getPitch(),
  }

  // Вне экрана, но с размером: MapLibre рисует по размеру контейнера
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    pointerEvents: 'none',
  })
  document.body.append(container)

  const style = source.getStyle()
  const map = new maplibregl.Map({
    container,
    style,
    center: camera.center,
    zoom: camera.zoom,
    bearing: camera.bearing ?? 0,
    pitch: camera.pitch ?? 0,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  })
  // Значки и фигуры слоёв данных — SDF, добавленные исходной карте на лету
  map.on('styleimagemissing', (event) => {
    if (map.hasImage(event.id) || !source.hasImage(event.id)) return
    const image = source.getImage(event.id)
    if (!image?.data) return
    map.addImage(
      event.id,
      { width: image.data.width, height: image.data.height, data: image.data.data },
      { pixelRatio: image.pixelRatio, sdf: image.sdf },
    )
  })
  map.on('error', () => undefined)

  try {
    const complete = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), options.timeout ?? DEFAULT_TIMEOUT)
      map.once('idle', () => {
        window.clearTimeout(timer)
        resolve(true)
      })
    })
    // Кадр дорисован: с `preserveDrawingBuffer` буфер не очищается после показа
    map.redraw()
    const canvas = document.createElement('canvas')
    const frame = map.getCanvas()
    canvas.width = frame.width
    canvas.height = frame.height
    canvas.getContext('2d')?.drawImage(frame, 0, 0)
    const y = height / 2
    const left = map.unproject([width / 2 - 50, y])
    const right = map.unproject([width / 2 + 50, y])
    return {
      canvas,
      complete,
      metersPerPixel: haversine([left.lng, left.lat], [right.lng, right.lat]) / 100,
      bearing: map.getBearing(),
      attribution: styleAttribution(style),
    }
  } finally {
    map.remove()
    container.remove()
  }
}
