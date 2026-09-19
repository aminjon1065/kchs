import { formatNumber } from '@kchs/fields'
import { Button, type MapLayerSpecification, useMapTheme } from '@kchs/ui'
import { Pentagon, Ruler } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useStudio } from './context.js'
import {
  areaValue,
  distanceValue,
  lineLength,
  type MeasureValue,
  type Position,
  polygonMeasure,
  ring,
} from './measure.js'
import { EMPTY_OVERLAY, type OverlayData, useToolOverlay } from './overlay.js'

/** Точки ближе этого — одна (второй щелчок двойного щелчка), px. */
const SAME_POINT = 3

/** Инструменты измерения студии. */
export const MEASURE_TOOLS = { line: 'measure-line', area: 'measure-area' } as const

/** Значение измерения на языке интерфейса: «12,34 км», «3,5 га». */
export function useMeasureText(): (value: MeasureValue) => string {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (value) =>
    t(`gis.measure.units.${value.unit}`, {
      value: formatNumber(value.value, { precision: value.precision }, { locale }),
    })
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    Boolean(target.closest('[role="dialog"]'))
  )
}

/**
 * Измерение расстояния и площади (P2-E02 S02, ADR-0073): щелчки ставят
 * вершины, двойной щелчок или Enter завершают, Backspace убирает последнюю
 * точку, Esc сбрасывает измерение, а без точек — выключает инструмент. Расчёт
 * на сфере (turf), геометрия — временный GeoJSON-слой поверх карты.
 */
export function MeasureTool() {
  const t = useT()
  const text = useMeasureText()
  const studio = useStudio()
  const { map, tool, setTool } = studio
  const mode = tool === MEASURE_TOOLS.line ? 'line' : tool === MEASURE_TOOLS.area ? 'area' : null
  const theme = useMapTheme(map?.getContainer() ?? null)
  const [points, setPoints] = useState<Position[]>([])
  const [hover, setHover] = useState<Position | null>(null)
  const [done, setDone] = useState(false)
  const state = useRef({ points, done, mode })
  state.current = { points, done, mode }

  // Новый режим — новое измерение
  // biome-ignore lint/correctness/useExhaustiveDependencies: сброс по смене режима
  useEffect(() => {
    setPoints([])
    setHover(null)
    setDone(false)
  }, [mode])

  useEffect(() => {
    if (!map || !mode) return
    const container = map.getCanvasContainer()
    container.style.cursor = 'crosshair'
    map.doubleClickZoom.disable()
    const onClick = (event: {
      point: { x: number; y: number }
      lngLat: { lng: number; lat: number }
    }) => {
      const point: Position = [event.lngLat.lng, event.lngLat.lat]
      const { points: current, done: finished } = state.current
      if (finished) {
        setPoints([point])
        setDone(false)
        return
      }
      const last = current[current.length - 1]
      if (last) {
        const at = map.project(last)
        if (Math.hypot(at.x - event.point.x, at.y - event.point.y) < SAME_POINT) return
      }
      setPoints([...current, point])
    }
    const onMove = (event: { lngLat: { lng: number; lat: number } }) => {
      if (!state.current.done) setHover([event.lngLat.lng, event.lngLat.lat])
    }
    const onDouble = () => {
      if (state.current.points.length > 1) setDone(true)
    }
    const onOut = () => setHover(null)
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return
      const { points: current, done: finished } = state.current
      if (event.key === 'Escape') {
        event.preventDefault()
        if (current.length > 0) {
          setPoints([])
          setDone(false)
        } else setTool(null)
      } else if (event.key === 'Enter' && current.length > 1 && !finished) {
        event.preventDefault()
        setDone(true)
      } else if (event.key === 'Backspace' && current.length > 0 && !finished) {
        event.preventDefault()
        setPoints(current.slice(0, -1))
      }
    }
    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('dblclick', onDouble)
    map.on('mouseout', onOut)
    window.addEventListener('keydown', onKey)
    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('dblclick', onDouble)
      map.off('mouseout', onOut)
      window.removeEventListener('keydown', onKey)
      container.style.cursor = ''
      try {
        map.doubleClickZoom.enable()
      } catch {
        // Карта уже удалена
      }
    }
  }, [map, mode, setTool])

  // Ломаная с «резинкой» до курсора, пока измерение не завершено
  const drawn = useMemo(() => (done || !hover ? points : [...points, hover]), [done, hover, points])
  const data = useMemo<OverlayData>(() => {
    if (!mode || drawn.length === 0) return EMPTY_OVERLAY
    const features: OverlayData['features'] = points.map((point) => ({
      type: 'Feature',
      properties: { kind: 'vertex' },
      geometry: { type: 'Point', coordinates: point },
    }))
    if (drawn.length > 1) {
      features.unshift({
        type: 'Feature',
        properties: { kind: 'line' },
        geometry: {
          type: 'LineString',
          coordinates: mode === 'area' && drawn.length > 2 ? ring(drawn) : drawn,
        },
      })
    }
    if (mode === 'area' && drawn.length > 2) {
      features.unshift({
        type: 'Feature',
        properties: { kind: 'area' },
        geometry: { type: 'Polygon', coordinates: [ring(drawn)] },
      })
    }
    return { type: 'FeatureCollection', features }
  }, [mode, points, drawn])

  useToolOverlay(
    map,
    'measure',
    data,
    (source) => {
      // Цвета — из токенов темы: слои появятся, как только тема прочитана
      if (!theme) return []
      const accent = theme.tokens.accent
      const surface = theme.surface
      return [
        {
          id: 'measure-area',
          type: 'fill',
          source,
          filter: ['==', ['get', 'kind'], 'area'],
          paint: { 'fill-color': accent, 'fill-opacity': 0.14 },
        },
        {
          id: 'measure-line',
          type: 'line',
          source,
          filter: ['==', ['get', 'kind'], 'line'],
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': accent, 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        },
        {
          id: 'measure-vertex',
          type: 'circle',
          source,
          filter: ['==', ['get', 'kind'], 'vertex'],
          paint: {
            'circle-radius': 4,
            'circle-color': surface,
            'circle-stroke-color': accent,
            'circle-stroke-width': 2,
          },
        },
      ] as MapLayerSpecification[]
    },
    theme?.mode ?? '',
  )

  if (!map || !mode) return null
  const lengthMeters = lineLength(drawn)
  const polygon = mode === 'area' ? polygonMeasure(drawn) : null
  const lastSegment = drawn.length > 1 ? lineLength(drawn.slice(-2)) : 0
  const Icon = mode === 'area' ? Pentagon : Ruler

  return createPortal(
    <section
      aria-label={mode === 'area' ? t('gis.measure.area') : t('gis.measure.distance')}
      className="absolute bottom-16 left-1/2 z-20 flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 font-sans shadow-md"
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-accent" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-fg" aria-live="polite">
          {polygon ? (
            drawn.length > 2 ? (
              <>
                <span className="font-semibold tabular">
                  {t('gis.measure.areaValue', { value: text(areaValue(polygon.area)) })}
                </span>
                <span className="text-fg-secondary">
                  {' · '}
                  {t('gis.measure.perimeter', { value: text(distanceValue(polygon.perimeter)) })}
                </span>
              </>
            ) : (
              <span className="text-fg-secondary">{t('gis.measure.areaHint')}</span>
            )
          ) : drawn.length > 1 ? (
            <>
              <span className="font-semibold tabular">
                {t('gis.measure.distanceValue', { value: text(distanceValue(lengthMeters)) })}
              </span>
              {drawn.length > 2 ? (
                <span className="text-fg-secondary">
                  {' · '}
                  {t('gis.measure.segment', { value: text(distanceValue(lastSegment)) })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-fg-secondary">{t('gis.measure.lineHint')}</span>
          )}
        </p>
      </div>
      <p className="text-xs text-fg-muted">
        {done ? t('gis.measure.doneHint') : t('gis.measure.keysHint')}
      </p>
      <div className="flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={points.length === 0}
          onClick={() => {
            setPoints([])
            setDone(false)
          }}
        >
          {t('gis.measure.reset')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setTool(null)}>
          {t('gis.tools.finish')}
        </Button>
      </div>
    </section>,
    map.getContainer(),
  )
}
