/**
 * Раскладка событий дня в сетке времени: пересекающиеся события делят
 * ширину колонки. Группа — цепочка пересечений; внутри группы событие
 * занимает первую свободную дорожку, ширина — доля числа дорожек группы.
 */

export interface LaneInput {
  key: string
  start: number
  end: number
}

export interface LaneBox {
  key: string
  /** Номер дорожки внутри группы. */
  lane: number
  /** Дорожек в группе. */
  lanes: number
}

export function layoutLanes(items: LaneInput[]): Map<string, LaneBox> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const result = new Map<string, LaneBox>()
  let group: Array<{ key: string; lane: number; end: number }> = []
  let groupEnd = Number.NEGATIVE_INFINITY

  const close = () => {
    const lanes = group.reduce((max, item) => Math.max(max, item.lane + 1), 0)
    for (const item of group) result.set(item.key, { key: item.key, lane: item.lane, lanes })
    group = []
  }

  for (const item of sorted) {
    // Короткое событие занимает хотя бы 15 минут высоты — так же считаем пересечения
    const end = Math.max(item.end, item.start + 15)
    if (item.start >= groupEnd) {
      close()
      groupEnd = Number.NEGATIVE_INFINITY
    }
    const busy = new Set(group.filter((other) => other.end > item.start).map((other) => other.lane))
    let lane = 0
    while (busy.has(lane)) lane++
    group.push({ key: item.key, lane, end })
    groupEnd = Math.max(groupEnd, end)
  }
  close()
  return result
}

export interface SpanInput {
  key: string
  /** Первый и последний день (номера колонок, включительно). */
  first: number
  last: number
}

/** Полосы событий на весь день: многодневное не пересекается с соседними. */
export function layoutRows(items: SpanInput[]): Map<string, number> {
  const sorted = [...items].sort(
    (a, b) => a.first - b.first || b.last - b.first - (a.last - a.first),
  )
  const rows: number[][] = []
  const result = new Map<string, number>()
  for (const item of sorted) {
    let row = 0
    while (rows[row]?.some((day) => day >= item.first && day <= item.last)) row++
    const days = rows[row] ?? []
    for (let day = item.first; day <= item.last; day++) days.push(day)
    rows[row] = days
    result.set(item.key, row)
  }
  return result
}

/** Минуты с шагом привязки. */
export function snapMinutes(minutes: number, step: number): number {
  return Math.round(minutes / step) * step
}
