import { clockMinutes, instantAt, localDate, MINUTE_MS, wallMs } from './time.js'

/**
 * Подбор времени встречи (12-calendar-notifications-home.md §1, ADR-0081) —
 * чистая функция: окна, в которые свободны все обязательные участники и
 * ресурсы, в рабочие часы каждого участника (в его поясе) и в рабочие дни
 * производственного календаря.
 */

export interface Interval {
  start: number
  end: number
}

export interface SlotPerson {
  timezone: string
  workingHours: { start: string; end: string }
  /** Занятость: отсортированные интервалы. */
  busy: Interval[]
}

export interface FindSlotsInput {
  from: number
  to: number
  durationMs: number
  /** Шаг кандидатов по часам запрашивающего (30 минут). */
  stepMinutes: number
  /** Раньше этого момента не предлагать (сейчас). */
  notBefore: number
  required: SlotPerson[]
  optional: SlotPerson[]
  resources: Interval[][]
  workingHoursOnly: boolean
  /** Рабочий ли день (дата в поясе участника). */
  isWorkingDay: (date: string) => boolean
  /** Пояс запрашивающего: выравнивание шага и «не больше N окон в день». */
  timezone: string
  limit: number
  perDay: number
}

export interface Slot {
  start: number
  end: number
  optionalBusy: number
}

/** Пересекается ли окно с занятостью; интервалы слиты — отсортированы и не пересекаются. */
export function busyDuring(busy: Interval[], start: number, end: number): boolean {
  let low = 0
  let high = busy.length
  // Первый интервал, который заканчивается позже начала окна
  while (low < high) {
    const middle = (low + high) >> 1
    if ((busy[middle]?.end ?? 0) <= start) low = middle + 1
    else high = middle
  }
  const candidate = busy[low]
  return candidate !== undefined && candidate.start < end
}

/** Слияние интервалов: отсортированные и без пересечений. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else merged.push({ ...interval })
  }
  return merged
}

/** Окно целиком в рабочих часах участника в рабочий день его пояса. */
function withinWorkingHours(
  person: SlotPerson,
  start: number,
  end: number,
  isWorkingDay: (date: string) => boolean,
): boolean {
  const date = localDate(start, person.timezone)
  if (!isWorkingDay(date)) return false
  const dayStart = instantAt(date, clockMinutes(person.workingHours.start), person.timezone)
  const dayEnd = instantAt(date, clockMinutes(person.workingHours.end), person.timezone)
  return start >= dayStart && end <= dayEnd
}

/** Первый кандидат: ближайшая отметка шага по часам запрашивающего не раньше `at`. */
function alignedStart(at: number, stepMinutes: number, timezone: string): number {
  const wall = wallMs(at, timezone)
  const step = stepMinutes * MINUTE_MS
  const aligned = Math.ceil(wall / step) * step
  return at + (aligned - wall)
}

export function findSlots(input: FindSlotsInput): Slot[] {
  const slots: Slot[] = []
  const perDay = new Map<string, number>()
  const step = input.stepMinutes * MINUTE_MS
  const required = input.required.map((person) => ({
    ...person,
    busy: mergeIntervals(person.busy),
  }))
  const optional = input.optional.map((person) => ({
    ...person,
    busy: mergeIntervals(person.busy),
  }))
  const resources = input.resources.map((busy) => mergeIntervals(busy))

  let start = alignedStart(Math.max(input.from, input.notBefore), input.stepMinutes, input.timezone)
  while (start + input.durationMs <= input.to && slots.length < input.limit) {
    const end = start + input.durationMs
    const day = localDate(start, input.timezone)
    const free =
      (perDay.get(day) ?? 0) < input.perDay &&
      required.every(
        (person) =>
          !busyDuring(person.busy, start, end) &&
          (!input.workingHoursOnly || withinWorkingHours(person, start, end, input.isWorkingDay)),
      ) &&
      resources.every((busy) => !busyDuring(busy, start, end))
    if (free) {
      slots.push({
        start,
        end,
        optionalBusy: optional.filter((person) => busyDuring(person.busy, start, end)).length,
      })
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
      // Следующее окно — после этого: предложения не перекрываются
      start = alignedStart(end, input.stepMinutes, input.timezone)
      continue
    }
    start += step
  }
  return slots
}
