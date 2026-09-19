import { MAP_TIME_MODES, MAP_TIME_STEPS, type MapTimeMode, type MapTimeStep } from '@kchs/contracts'
import {
  IconButton,
  type MapInstance,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Spinner,
  useMediaQuery,
} from '@kchs/ui'
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useStudio } from './context.js'
import {
  addSteps,
  formatWall,
  formatWindow,
  frameInterval,
  nextWindow,
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
  playbackStart,
  previousWindow,
  type TimeWindow,
} from './time-model.js'
import { reshapeWindow, useStudioTime } from './time-state.js'

/** Кадр не ждёт тайлы дольше: медленный слой не останавливает воспроизведение. */
const IDLE_WAIT = 4000

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** Карта дорисовала кадр (тайлы нового интервала загружены) — или прошло `timeout`. */
function mapIdle(map: MapInstance | null, timeout: number): Promise<void> {
  if (!map) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer)
      map.off('idle', done)
      resolve()
    }
    const timer = window.setTimeout(done, timeout)
    map.once('idle', done)
  })
}

/** Бегунки ползунка → окно шкалы: диапазон — два, момент и накопление — один. */
function sliderWindow(values: number[], mode: MapTimeMode): TimeWindow {
  const first = values[0] ?? 0
  if (mode === 'range') return { start: first, end: values[1] ?? first }
  if (mode === 'cumulative') return { start: 0, end: first }
  return { start: first, end: first }
}

function sliderValues(span: TimeWindow, mode: MapTimeMode): number[] {
  if (mode === 'range') return [span.start, span.end]
  return [mode === 'cumulative' ? span.end : span.start]
}

/**
 * Шкала времени поверх карты (07-gis-engine.md §12, P2-E02 S05, ADR-0074):
 * диапазон данных слоёв со временем, окно «с — по» на шаге шкалы, режимы
 * «диапазон», «момент», «накопление», воспроизведение с паузой и скоростью.
 * Окно пишется в `MapSpec.time` и уходит тайлам параметром `t`; следующий кадр
 * ждёт, пока карта дорисует текущий. При `prefers-reduced-motion` скорость по
 * умолчанию ниже, а подпись интервала объявляется только на паузе.
 */
export function TimeBar() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { map } = useStudio()
  const time = useStudioTime()
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(reducedMotion ? 0.5 : 1)
  const [draft, setDraft] = useState<TimeWindow | null>(null)
  const latest = useRef(time)
  latest.current = time

  const enabled = time.time !== null
  useEffect(() => {
    if (!enabled) setPlaying(false)
  }, [enabled])

  // Воспроизведение: кадр — после паузы скорости и дорисовки прошлого кадра
  useEffect(() => {
    if (!playing) return
    let cancelled = false
    let timer = 0
    const frame = async () => {
      const state = latest.current
      const next =
        state.scale && state.window ? nextWindow(state.window, state.mode, state.scale.count) : null
      if (!next) {
        setPlaying(false)
        return
      }
      state.apply(next)
      await Promise.all([delay(frameInterval(speed)), mapIdle(map, IDLE_WAIT)])
      if (!cancelled) timer = window.setTimeout(frame, 0)
    }
    timer = window.setTimeout(frame, frameInterval(speed))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [playing, speed, map])

  if (!enabled || time.layers.length === 0) return null
  const { scale, window: current, mode, step } = time
  const span = draft ?? current

  const play = () => {
    if (!scale || !current) return
    const start = playbackStart(current, mode, scale.count)
    if (start.start !== current.start || start.end !== current.end) time.apply(start)
    setPlaying(true)
  }
  const change = (next: { mode?: MapTimeMode; step?: MapTimeStep }) => {
    setPlaying(false)
    const reshaped = reshapeWindow(time, next.mode ?? mode, next.step ?? step)
    if (reshaped) time.apply(reshaped, next)
  }
  const label = scale && span ? formatWindow(span, scale.origin, step, locale) : null
  const steps = MAP_TIME_STEPS.filter((item) => item !== 'hour' || time.hourly || step === 'hour')

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-9 z-10 flex justify-center px-3">
      <section
        aria-label={t('gis.time.bar')}
        className="pointer-events-auto flex w-full max-w-[760px] flex-col gap-1.5 rounded-md border border-line bg-surface px-3 py-2 shadow-md"
      >
        {/* Подпись интервала — во всю ширину; режим, шаг и скорость уходят на строку ниже на узкой карте */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <div className="flex min-w-[15rem] flex-1 items-center gap-1.5">
            <IconButton
              label={t('gis.time.previous')}
              size="sm"
              disabled={!current || !previousWindow(current, mode)}
              onClick={() => {
                const previous = current ? previousWindow(current, mode) : null
                setPlaying(false)
                if (previous) time.apply(previous)
              }}
            >
              <SkipBack className="size-3.5" aria-hidden />
            </IconButton>
            <IconButton
              label={playing ? t('gis.time.pause') : t('gis.time.play')}
              size="sm"
              variant="primary"
              disabled={!scale || !current || scale.count < 2}
              onClick={() => (playing ? setPlaying(false) : play())}
            >
              {playing ? (
                <Pause className="size-3.5" aria-hidden />
              ) : (
                <Play className="size-3.5" aria-hidden />
              )}
            </IconButton>
            <IconButton
              label={t('gis.time.next')}
              size="sm"
              disabled={!scale || !current || !nextWindow(current, mode, scale.count)}
              onClick={() => {
                const next = scale && current ? nextWindow(current, mode, scale.count) : null
                setPlaying(false)
                if (next) time.apply(next)
              }}
            >
              <SkipForward className="size-3.5" aria-hidden />
            </IconButton>
            <p
              role="status"
              className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg tabular"
              // Кадры воспроизведения не зачитываются: объявляется интервал на паузе
              aria-live={playing ? 'off' : 'polite'}
            >
              {label
                ? label.to
                  ? t('gis.time.interval', { from: label.from, to: label.to })
                  : label.from
                : time.loading
                  ? t('gis.time.loading')
                  : t('gis.time.noData')}
            </p>
            {time.loading ? <Spinner className="size-3.5" label={t('gis.time.loading')} /> : null}
          </div>
          <div className="flex items-center gap-1.5">
            <Select value={mode} onValueChange={(next) => change({ mode: next as MapTimeMode })}>
              <SelectTrigger aria-label={t('gis.time.mode')} className="h-7 w-[7.5rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAP_TIME_MODES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`gis.time.modes.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={step} onValueChange={(next) => change({ step: next as MapTimeStep })}>
              <SelectTrigger aria-label={t('gis.time.step')} className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {steps.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`gis.time.steps.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(speed)}
              onValueChange={(next) => setSpeed(Number(next) as PlaybackSpeed)}
            >
              <SelectTrigger aria-label={t('gis.time.speed')} className="h-7 w-[4.5rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAYBACK_SPEEDS.map((item) => (
                  <SelectItem key={item} value={String(item)}>
                    {t('gis.time.speedValue', {
                      value: new Intl.NumberFormat(locale).format(item),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IconButton label={t('gis.time.hide')} size="sm" onClick={() => time.disable()}>
              <X className="size-3.5" aria-hidden />
            </IconButton>
          </div>
        </div>
        {scale && span ? (
          <div className="flex items-center gap-2 text-2xs text-fg-muted tabular">
            <span className="shrink-0">{formatWall(scale.origin, step, locale)}</span>
            <Slider
              size="sm"
              min={0}
              max={Math.max(0, scale.count - 1)}
              step={1}
              value={sliderValues(span, mode)}
              disabled={scale.count < 2}
              thumbLabels={
                mode === 'range'
                  ? [t('gis.time.from'), t('gis.time.to')]
                  : [t(mode === 'cumulative' ? 'gis.time.until' : 'gis.time.moment')]
              }
              valueText={(index) => formatWall(addSteps(scale.origin, step, index), step, locale)}
              onPointerDown={() => setPlaying(false)}
              onValueChange={(values) => setDraft(sliderWindow(values, mode))}
              onValueCommit={(values) => {
                setDraft(null)
                setPlaying(false)
                time.apply(sliderWindow(values, mode))
              }}
            />
            <span className="shrink-0">
              {formatWall(addSteps(scale.origin, step, scale.count - 1), step, locale)}
            </span>
          </div>
        ) : null}
      </section>
    </div>
  )
}
