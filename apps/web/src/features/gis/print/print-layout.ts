import type { LegendModel, LegendSwatch } from '@kchs/map-style'

/**
 * Макет печати карты (07-gis-engine.md §13, P2-E02 S06, ADR-0074): лист A4/A3
 * книжный или альбомный либо «текущий вид» — кадр карты размером с экран. Всё
 * считается в логических пикселях (1/96 дюйма), лист — в пикселях печати:
 * `unit` пикселей листа на логический пиксель (150 dpi на бумаге, ×2 для вида).
 */

export type PrintFormat = 'view' | 'a4' | 'a3'
export type PrintOrientation = 'portrait' | 'landscape'

export interface PrintOptions {
  format: PrintFormat
  orientation: PrintOrientation
  title: string
  legend: boolean
  scaleBar: boolean
  north: boolean
  /** Дата и автор в подвале листа. */
  signature: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Размер бумаги, мм (книжная ориентация). */
const PAPER_MM = { a4: [210, 297], a3: [297, 420] } as const
/** Разрешение листа печати, точек на дюйм. */
export const PRINT_DPI = 150
const CSS_DPI = 96
const MM_PER_INCH = 25.4
/** Выгрузка «текущего вида» — вдвое детальнее экрана. */
export const VIEW_SCALE = 2

/** Поля, заголовок, подвал и промежутки листа, логические пиксели. */
export const PRINT_METRICS = {
  paperMargin: 28,
  viewMargin: 16,
  header: 34,
  footer: 30,
  gap: 12,
  /** Колонка легенды справа от карты. */
  legendColumn: { min: 180, max: 260, share: 0.22, view: 220 },
  /** Колонка легенды в полосе под картой (книжный лист, узкий вид). */
  legendBandColumn: 180,
  /** Полоса легенды не выше этой доли листа — остальное карте. */
  legendBandShare: 0.32,
} as const

/** Строка легенды на листе: слой, часть легенды, образец с подписью, градиент, пояснение. */
export type LegendRow =
  | { kind: 'layer'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'item'; text: string; swatch: Exclude<LegendSwatch, { kind: 'heatmap-gradient' }> }
  | { kind: 'gradient'; text: string; swatch: Extract<LegendSwatch, { kind: 'heatmap-gradient' }> }
  | { kind: 'note'; text: string }

export const LEGEND_ROW_HEIGHT: Record<LegendRow['kind'], number> = {
  layer: 22,
  section: 16,
  item: 18,
  gradient: 34,
  note: 16,
}

/**
 * Легенды видимых слоёв → строки листа: название слоя, затем модель легенды.
 * Простой стиль (один образец с названием слоя) — одной строкой, без повтора.
 */
export function legendRows(legends: ReadonlyArray<{ name: string; legend: LegendModel }>) {
  const rows: LegendRow[] = []
  for (const { name, legend } of legends) {
    if (!legend.show) continue
    const only = legend.sections.length === 1 ? legend.sections[0]?.items : undefined
    const single = !legend.title && only?.length === 1 && only[0]?.label === name
    if (!single) rows.push({ kind: 'layer', text: name })
    if (legend.title && legend.title !== name) rows.push({ kind: 'section', text: legend.title })
    for (const section of legend.sections) {
      if (section.title) rows.push({ kind: 'section', text: section.title })
      for (const item of section.items) {
        if (item.swatch.kind === 'heatmap-gradient') {
          rows.push({ kind: 'gradient', text: item.label, swatch: item.swatch })
        } else {
          rows.push({ kind: 'item', text: item.label, swatch: item.swatch })
        }
      }
    }
    if (legend.note) rows.push({ kind: 'note', text: legend.note })
  }
  return rows
}

export interface PlacedRow {
  row: LegendRow
  x: number
  y: number
  w: number
}

/**
 * Строки легенды по колонкам прямоугольника сверху вниз, слева направо.
 * Название слоя не остаётся внизу колонки без первой строки под ним; что не
 * поместилось — `hidden` (лист покажет «ещё N»).
 */
export function flowLegend(
  rows: readonly LegendRow[],
  rect: Rect,
  columnWidth: number,
  gap: number = PRINT_METRICS.gap,
): { placed: PlacedRow[]; hidden: number; columns: number } {
  const columns = Math.max(1, Math.floor((rect.w + gap) / (columnWidth + gap)))
  const width = (rect.w - gap * (columns - 1)) / columns
  const placed: PlacedRow[] = []
  let column = 0
  let y = rect.y
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as LegendRow
    const height = LEGEND_ROW_HEIGHT[row.kind]
    const next = rows[index + 1]
    const needed = height + (row.kind === 'layer' && next ? LEGEND_ROW_HEIGHT[next.kind] : 0)
    if (y + needed > rect.y + rect.h && y > rect.y) {
      column++
      y = rect.y
    }
    if (column >= columns || y + height > rect.y + rect.h) {
      return { placed, hidden: rows.length - index, columns }
    }
    placed.push({ row, x: rect.x + column * (width + gap), y, w: width })
    y += height
  }
  return { placed, hidden: 0, columns }
}

export interface PrintLayout {
  /** Пикселей листа на логический пиксель. */
  unit: number
  /** Лист, пиксели печати. */
  page: { width: number; height: number }
  /** Лист, логические пиксели. */
  logical: { width: number; height: number }
  margin: number
  header: Rect | null
  map: Rect
  legend: Rect | null
  footer: Rect
}

/** Лист бумаги в пунктах PDF (1/72 дюйма) с учётом ориентации. */
export function paperPoints(
  format: Exclude<PrintFormat, 'view'>,
  orientation: PrintOrientation,
): [number, number] {
  const [short, long] = PAPER_MM[format]
  const toPt = (mm: number) => (mm / MM_PER_INCH) * 72
  return orientation === 'portrait' ? [toPt(short), toPt(long)] : [toPt(long), toPt(short)]
}

/** Наименьшая высота полосы, в которую строки легенды входят целиком (или предел). */
function bandHeight(rows: readonly LegendRow[], width: number, limit: number): number {
  const total = rows.reduce((sum, row) => sum + LEGEND_ROW_HEIGHT[row.kind], 0)
  const tallest = Math.max(...rows.map((row) => LEGEND_ROW_HEIGHT[row.kind]))
  let height = Math.min(limit, tallest)
  while (height < limit) {
    const rect = { x: 0, y: 0, w: width, h: height }
    if (flowLegend(rows, rect, PRINT_METRICS.legendBandColumn).hidden === 0) return height
    height += 4
  }
  return Math.min(limit, Math.max(total > 0 ? tallest : 0, height))
}

/**
 * Раскладка листа: заголовок, карта, легенда (колонка справа — альбомный лист
 * и широкий вид; полоса снизу — книжный лист и узкий вид), подвал с атрибуцией.
 * Для «текущего вида» карта — размером с экранную, лист строится вокруг неё.
 */
export function printLayout(input: {
  options: Pick<PrintOptions, 'format' | 'orientation' | 'title' | 'legend'>
  /** Размер карты на экране, логические пиксели. */
  view: { width: number; height: number }
  rows: readonly LegendRow[]
}): PrintLayout {
  const { options, view } = input
  const m = PRINT_METRICS
  const rows = options.legend ? input.rows : []
  const header = options.title.trim() ? m.header : 0
  const paper = options.format !== 'view'
  const margin = paper ? m.paperMargin : m.viewMargin
  const unit = paper ? PRINT_DPI / CSS_DPI : VIEW_SCALE

  let width: number
  let height: number
  let map: Rect
  let legend: Rect | null = null
  const top = margin + (header ? header + m.gap / 2 : 0)

  if (options.format !== 'view') {
    const [wPt, hPt] = paperPoints(options.format, options.orientation)
    width = (wPt / 72) * CSS_DPI
    height = (hPt / 72) * CSS_DPI
    const contentW = width - 2 * margin
    const bottom = height - margin - m.footer - m.gap
    if (rows.length > 0 && options.orientation === 'landscape') {
      const column = Math.min(
        m.legendColumn.max,
        Math.max(m.legendColumn.min, contentW * m.legendColumn.share),
      )
      map = { x: margin, y: top, w: contentW - column - m.gap, h: bottom - top }
      legend = { x: margin + map.w + m.gap, y: top, w: column, h: map.h }
    } else if (rows.length > 0) {
      const band = bandHeight(rows, contentW, (bottom - top) * m.legendBandShare)
      map = { x: margin, y: top, w: contentW, h: bottom - top - band - m.gap }
      legend = { x: margin, y: map.y + map.h + m.gap, w: contentW, h: band }
    } else {
      map = { x: margin, y: top, w: contentW, h: bottom - top }
    }
  } else {
    map = { x: margin, y: top, w: view.width, h: view.height }
    const beside = rows.length > 0 && view.width >= 560
    if (beside) {
      legend = { x: margin + map.w + m.gap, y: top, w: m.legendColumn.view, h: map.h }
    } else if (rows.length > 0) {
      const band = bandHeight(rows, map.w, Math.max(120, map.h * m.legendBandShare * 2))
      legend = { x: margin, y: top + map.h + m.gap, w: map.w, h: band }
    }
    width = margin * 2 + map.w + (beside && legend ? m.gap + legend.w : 0)
    const below = legend && !beside ? m.gap + legend.h : 0
    height = top + map.h + below + m.gap + m.footer + margin
  }

  return {
    unit,
    page: { width: Math.round(width * unit), height: Math.round(height * unit) },
    logical: { width, height },
    margin,
    header: header ? { x: margin, y: margin, w: width - 2 * margin, h: header } : null,
    map,
    legend,
    footer: { x: margin, y: height - margin - m.footer, w: width - 2 * margin, h: m.footer },
  }
}

/** Длины масштабной линейки: 1, 2, 5 × 10ⁿ метров. */
export function scaleBar(
  metersPerPixel: number,
  maxWidth: number,
): { meters: number; width: number } | null {
  if (!(metersPerPixel > 0) || !(maxWidth > 0)) return null
  const limit = metersPerPixel * maxWidth
  const power = 10 ** Math.floor(Math.log10(limit))
  const meters = [5, 2, 1].map((n) => n * power).find((value) => value <= limit) ?? power
  return { meters, width: meters / metersPerPixel }
}

/** Символы, недопустимые в именах файлов Windows и macOS. */
const FORBIDDEN = '\\/:*?"<>|'

/** Имя файла выгрузки: заголовок без запрещённых и управляющих символов. */
export function printFileName(title: string, extension: 'png' | 'pdf'): string {
  const base = Array.from(title, (char) =>
    char.charCodeAt(0) < 32 || FORBIDDEN.includes(char) ? ' ' : char,
  )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${base || 'map'}.${extension}`
}
