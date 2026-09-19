import type { LayerRecord, MapTime, MapTimeMode, MapTimeStep } from '@kchs/contracts'
import { useMemo } from 'react'
import { useStudio } from './context.js'
import { useTimeDomain } from './time-domain.js'
import {
  coerceWindow,
  initialWindow,
  type TimeDomain,
  type TimeWindow,
  timeLayers,
  timeScale,
  timeSettings,
  timeWindow,
  type Wall,
  windowTime,
} from './time-model.js'

export interface StudioTime {
  /** Видимые слои со временем и доступом к данным. */
  layers: LayerRecord[]
  domain: TimeDomain | null
  loading: boolean
  /** Поле времени всех слоёв — дата-время: доступен шаг «час». */
  hourly: boolean
  /** Интервал карты; null — время выключено. */
  time: MapTime | null
  mode: MapTimeMode
  step: MapTimeStep
  /** Шкала над диапазоном данных; null — диапазона ещё нет. */
  scale: { origin: Wall; count: number } | null
  /** Текущее окно шкалы; null — время выключено или диапазона нет. */
  window: TimeWindow | null
  /** Записать окно в `MapSpec.time` (тайлы получат новый `t`). */
  apply: (window: TimeWindow, change?: { mode?: MapTimeMode; step?: MapTimeStep }) => void
  enable: () => void
  disable: () => void
}

/**
 * Время карты-студии для панели инструментов и шкалы (P2-E02 S05, ADR-0074):
 * слои со временем, их общий диапазон данных, режим и шаг, окно шкалы.
 * Интервал живёт в `MapSpec.time` — правится через `editSpec`.
 */
export function useStudioTime(): StudioTime {
  const { spec, editSpec, layers: panelLayers } = useStudio()
  const layerKey = panelLayers
    .map(({ entry, layer }) => `${entry.layerId}:${entry.visible}:${layer?.version ?? '-'}`)
    .join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: состав слоёв — по ключу
  const layers = useMemo(() => timeLayers(panelLayers), [layerKey])
  const { domain, loading, hourly } = useTimeDomain(layers)
  const time = spec.time
  const { mode, step } = timeSettings(time, layers)
  const min = domain?.min
  const max = domain?.max
  const scale = useMemo(
    () => (min !== undefined && max !== undefined ? timeScale({ min, max }, step) : null),
    [min, max, step],
  )
  const window = scale && time ? timeWindow(time, scale.origin, step, scale.count) : null

  const apply: StudioTime['apply'] = (next, change = {}) => {
    if (min === undefined || max === undefined) return
    const nextStep = change.step ?? step
    const nextMode = change.mode ?? mode
    const target = timeScale({ min, max }, nextStep)
    editSpec((current) => ({
      ...current,
      time: windowTime(next, target.origin, nextStep, nextMode),
    }))
  }

  return {
    layers,
    domain,
    loading,
    hourly,
    time,
    mode,
    step,
    scale,
    window,
    apply,
    enable: () => {
      if (!scale) return
      apply(initialWindow(mode, scale.count))
    },
    disable: () => editSpec((current) => ({ ...current, time: null })),
  }
}

/** Окно после смены режима или шага: тот же интервал в новой шкале. */
export function reshapeWindow(
  state: Pick<StudioTime, 'time' | 'domain'>,
  mode: MapTimeMode,
  step: MapTimeStep,
): TimeWindow | null {
  if (!state.domain || !state.time) return null
  const target = timeScale(state.domain, step)
  const window = timeWindow(state.time, target.origin, step, target.count)
  return window ? coerceWindow(window, mode) : null
}
