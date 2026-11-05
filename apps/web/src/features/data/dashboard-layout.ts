import { DASHBOARD_COLUMNS, type DashboardTile } from '@kchs/contracts'

/** Плитки в порядке показа: сверху вниз, слева направо. */
export function orderedTiles(tiles: readonly DashboardTile[]): DashboardTile[] {
  return [...tiles].sort((a, b) => a.y - b.y || a.x - b.x)
}

/** Строк сетки под плитками: нижний край самой низкой (высота плитки — не больше 8). */
export function gridRows(tiles: readonly DashboardTile[]): number {
  return tiles.reduce((rows, tile) => Math.max(rows, tile.y + Math.min(tile.h, 8)), 0)
}

/** Строка TV-режима: не ниже этой, иначе в плитке не уместятся заголовок и число. */
export const TV_MIN_ROW = 40
/** И не выше прежней: на большом экране плитки не растягиваются. */
export const TV_MAX_ROW = 112

/**
 * Высота строки TV-режима (ADR-0230): дашборд дежурной части должен быть виден на
 * экране целиком. Строки делят высоту области поровну за вычетом промежутков; ниже
 * `TV_MIN_ROW` — прокрутка, выше `TV_MAX_ROW` не растут. Область ещё не измерена —
 * прежняя высота.
 */
export function tvRowHeight(areaHeight: number, rows: number, gap: number): number {
  if (areaHeight <= 0 || rows <= 0) return TV_MAX_ROW
  const fit = Math.floor((areaHeight - gap * (rows - 1)) / rows)
  return Math.min(TV_MAX_ROW, Math.max(TV_MIN_ROW, fit))
}

/**
 * Раскладка по порядку: плитки встают в строку слева направо, не помещается —
 * новая строка ниже самой высокой плитки предыдущей. Так позиции после правки
 * ширины, высоты и порядка остаются без наложений.
 */
export function packTiles(tiles: readonly DashboardTile[]): DashboardTile[] {
  let x = 0
  let y = 0
  let rowHeight = 0
  return tiles.map((tile) => {
    const w = Math.min(Math.max(tile.w, 1), DASHBOARD_COLUMNS)
    if (x + w > DASHBOARD_COLUMNS) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    const placed = { ...tile, x, y, w }
    x += w
    rowHeight = Math.max(rowHeight, tile.h)
    return placed
  })
}

/** Сдвиг плитки в порядке показа на `delta` позиций. */
export function moveTile(tiles: readonly DashboardTile[], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= tiles.length) return [...tiles]
  const next = [...tiles]
  const [tile] = next.splice(index, 1)
  if (tile) next.splice(target, 0, tile)
  return next
}

/** Свободный идентификатор плитки или фильтра: `t1`, `t2`… */
export function nextId(prefix: string, taken: readonly string[]): string {
  let n = taken.length + 1
  while (taken.includes(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export const PERIOD_PRESETS = ['all', 'month', 'quarter', 'year', 'last30'] as const
export type PeriodPreset = (typeof PERIOD_PRESETS)[number]

/** Значение фильтра-периода: относительный диапазон или «всё время». */
export function periodValue(preset: PeriodPreset) {
  switch (preset) {
    case 'all':
      return null
    case 'last30':
      return { unit: 'day' as const, from: -29, to: 0 }
    default:
      return { unit: preset, from: 0, to: 0 }
  }
}

/** Значения фильтра «Значения» из строки через запятую. */
export function parseValues(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}
