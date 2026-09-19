import type { LayerRecord, MapTime, MapTimeMode, MapTimeStep } from '@kchs/contracts'

/**
 * Модель шкалы времени карты (07-gis-engine.md §12, ADR-0074). Моменты шкалы —
 * «настенное» время пояса пользователя, записанное как UTC (мс): шаги месяца,
 * недели и суток считаются календарём без переходов на летнее время, а интервал
 * уходит тайлам местными датами и временем без смещения — так же, как их
 * понимает компилятор запросов (целые сутки и время без пояса — в поясе запроса).
 */

/** Настенное время пояса пользователя как мс UTC. */
export type Wall = number

/** Диапазон значений поля времени слоёв (настенное время). */
export interface TimeDomain {
  min: Wall
  max: Wall
}

/** Окно шкалы — номера шагов от начала диапазона, оба конца включительно. */
export interface TimeWindow {
  start: number
  end: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let format = formatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timezone, format)
  }
  return format
}

/** Момент (мс эпохи) → настенное время пояса. */
export function wallOf(ms: number, timezone: string): Wall {
  const parts = partsFormatter(timezone).formatToParts(new Date(ms))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return (
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) +
    (((ms % 1000) + 1000) % 1000)
  )
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

/**
 * Значение поля времени из результата запроса → настенное время: дата —
 * полночь календарного дня, дата-время (ISO с поясом) — в поясе пользователя.
 */
export function wallFromValue(value: unknown, timezone: string): Wall | null {
  if (typeof value !== 'string') return null
  const date = ISO_DATE.exec(value)
  if (date) return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]))
  const local = LOCAL_DATETIME.exec(value)
  if (local) {
    return Date.UTC(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
      Number((local[7] ?? '0').padEnd(3, '0')),
    )
  }
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : wallOf(ms, timezone)
}

/** Начало шага, содержащего момент (неделя — с понедельника). */
export function floorStep(t: Wall, step: MapTimeStep): Wall {
  const d = new Date(t)
  switch (step) {
    case 'hour':
      return Math.floor(t / HOUR) * HOUR
    case 'day':
      return Math.floor(t / DAY) * DAY
    case 'week': {
      const day = Math.floor(t / DAY) * DAY
      const weekday = (new Date(day).getUTCDay() + 6) % 7
      return day - weekday * DAY
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1)
  }
}

/** Сдвиг начала шага на `n` шагов. */
export function addSteps(t: Wall, step: MapTimeStep, n: number): Wall {
  const d = new Date(t)
  switch (step) {
    case 'hour':
      return t + n * HOUR
    case 'day':
      return t + n * DAY
    case 'week':
      return t + n * 7 * DAY
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)
    case 'year':
      return Date.UTC(d.getUTCFullYear() + n, 0, 1)
  }
}

/** Номер шага момента от начала шкалы `origin` (начала шага). */
export function stepIndex(t: Wall, origin: Wall, step: MapTimeStep): number {
  const at = floorStep(t, step)
  switch (step) {
    case 'hour':
      return Math.round((at - origin) / HOUR)
    case 'day':
      return Math.round((at - origin) / DAY)
    case 'week':
      return Math.round((at - origin) / (7 * DAY))
    case 'month': {
      const a = new Date(at)
      const o = new Date(origin)
      return (a.getUTCFullYear() - o.getUTCFullYear()) * 12 + a.getUTCMonth() - o.getUTCMonth()
    }
    case 'year':
      return new Date(at).getUTCFullYear() - new Date(origin).getUTCFullYear()
  }
}

/** Шкала над диапазоном данных: начало первого шага и число шагов. */
export function timeScale(domain: TimeDomain, step: MapTimeStep): { origin: Wall; count: number } {
  const origin = floorStep(domain.min, step)
  return { origin, count: Math.max(1, stepIndex(domain.max, origin, step) + 1) }
}

function formatDate(t: Wall): string {
  const d = new Date(t)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function formatLocal(t: Wall): string {
  const d = new Date(t)
  return `${formatDate(t)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

/**
 * Окно → интервал карты (`MapSpec.time`, параметр тайлов `t`): оба конца
 * включительно. Шаг от суток — даты (целые сутки в поясе запроса), часы —
 * местное время без смещения до последней миллисекунды шага.
 */
export function windowTime(
  window: TimeWindow,
  origin: Wall,
  step: MapTimeStep,
  mode: MapTimeMode,
): MapTime {
  const from = addSteps(origin, step, window.start)
  const next = addSteps(origin, step, window.end + 1)
  if (step === 'hour') {
    return { from: formatLocal(from), to: formatLocal(next - 1), mode, step }
  }
  return { from: formatDate(from), to: formatDate(next - DAY), mode, step }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Интервал карты → окно шкалы (шаги, содержащие концы интервала). */
export function timeWindow(
  time: Pick<MapTime, 'from' | 'to'>,
  origin: Wall,
  step: MapTimeStep,
  count: number,
): TimeWindow | null {
  const from = wallFromValue(time.from, 'UTC')
  const to = wallFromValue(time.to, 'UTC')
  if (from === null || to === null) return null
  const start = clamp(stepIndex(from, origin, step), 0, count - 1)
  const end = clamp(stepIndex(to, origin, step), start, count - 1)
  return { start, end }
}

/** Окно при включении шкалы: диапазон — все данные, момент и накопление — первый шаг. */
export function initialWindow(mode: MapTimeMode, count: number): TimeWindow {
  return mode === 'range' ? { start: 0, end: count - 1 } : { start: 0, end: 0 }
}

/** Окно в другом режиме: момент — начало окна, накопление — от начала данных. */
export function coerceWindow(window: TimeWindow, mode: MapTimeMode): TimeWindow {
  if (mode === 'instant') return { start: window.start, end: window.start }
  if (mode === 'cumulative') return { start: 0, end: window.end }
  return window
}

/** Следующий кадр воспроизведения; null — данные кончились. */
export function nextWindow(
  window: TimeWindow,
  mode: MapTimeMode,
  count: number,
): TimeWindow | null {
  if (window.end + 1 >= count) return null
  if (mode === 'cumulative') return { start: 0, end: window.end + 1 }
  return { start: window.start + 1, end: window.end + 1 }
}

/** Предыдущий кадр; null — начало данных. */
export function previousWindow(window: TimeWindow, mode: MapTimeMode): TimeWindow | null {
  if (mode === 'cumulative') return window.end > 0 ? { start: 0, end: window.end - 1 } : null
  if (window.start === 0) return null
  return { start: window.start - 1, end: window.end - 1 }
}

/**
 * Окно, с которого начинается воспроизведение: у конца данных — сначала;
 * диапазон во все данные сужается до одного шага, иначе двигаться некуда.
 */
export function playbackStart(window: TimeWindow, mode: MapTimeMode, count: number): TimeWindow {
  if (mode === 'range' && window.start === 0 && window.end === count - 1 && count > 1) {
    return { start: 0, end: 0 }
  }
  if (nextWindow(window, mode, count)) return window
  const width = mode === 'range' ? window.end - window.start : 0
  return { start: 0, end: Math.min(width, count - 1) }
}

/** Скорости воспроизведения: кадров в секунду при скорости 1 — один на 1,2 с. */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]
const FRAME_MS = 1200

export function frameInterval(speed: number): number {
  return Math.round(FRAME_MS / speed)
}

/** Слои со временем, которые рисуются на карте: видимые и с доступом к данным. */
export function timeLayers(
  entries: ReadonlyArray<{ layer: LayerRecord | null; entry: { visible: boolean } }>,
): LayerRecord[] {
  return entries.flatMap(({ layer, entry }) =>
    layer?.style.time && layer.dataAccess && entry.visible ? [layer] : [],
  )
}

/** Режим и шаг шкалы: сохранённые в карте или первого слоя со временем. */
export function timeSettings(
  time: MapTime | null,
  layers: readonly LayerRecord[],
): { mode: MapTimeMode; step: MapTimeStep } {
  const style = layers[0]?.style.time
  return {
    mode: time?.mode ?? style?.mode ?? 'range',
    step: time?.step ?? style?.step ?? 'day',
  }
}

// ─── Подписи ─────────────────────────────────────────────────────────────────

const labelFormats = new Map<string, Intl.DateTimeFormat>()

function labelFormat(locale: string, step: MapTimeStep): Intl.DateTimeFormat {
  const key = `${locale}:${step}`
  let format = labelFormats.get(key)
  if (!format) {
    const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' }
    if (step === 'year') options.year = 'numeric'
    else if (step === 'month') Object.assign(options, { year: 'numeric', month: 'long' })
    else Object.assign(options, { year: 'numeric', month: 'short', day: 'numeric' })
    if (step === 'hour')
      Object.assign(options, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    format = new Intl.DateTimeFormat(locale, options)
    labelFormats.set(key, format)
  }
  return format
}

/** Подпись момента шкалы на её шаге: «март 2026», «1 мар. 2026 г.», «14:00». */
export function formatWall(t: Wall, step: MapTimeStep, locale: string): string {
  return labelFormat(locale, step).format(new Date(t))
}

/**
 * Подпись окна: начало первого шага и конец последнего включительно (неделя —
 * её последний день, час — его последняя минута); один шаг — одна подпись.
 */
export function formatWindow(
  window: TimeWindow,
  origin: Wall,
  step: MapTimeStep,
  locale: string,
): { from: string; to: string | null } {
  const start = addSteps(origin, step, window.start)
  const lastStart = addSteps(origin, step, window.end)
  const lastEnd = addSteps(origin, step, window.end + 1)
  const endStep: MapTimeStep = step === 'week' ? 'day' : step
  const endAt = step === 'week' ? lastEnd - DAY : step === 'hour' ? lastEnd - 60_000 : lastStart
  const single = window.start === window.end && step !== 'week' && step !== 'hour'
  return {
    from: formatWall(start, step === 'week' ? 'day' : step, locale),
    to: single ? null : formatWall(endAt, endStep, locale),
  }
}
