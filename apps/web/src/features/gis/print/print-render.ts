import type { LegendSwatch } from '@kchs/map-style'
import { type MapSnapshot, mapIconImage } from '@kchs/ui'
import {
  flowLegend,
  type LegendRow,
  PRINT_METRICS,
  type PrintLayout,
  type PrintOptions,
  type Rect,
  scaleBar,
} from './print-layout.js'

/** Цвета листа — светлая тема дизайн-системы (tokens.json): печать на белом. */
export interface PrintPalette {
  text: string
  secondary: string
  muted: string
  border: string
  surface: string
}

/** Шрифт листа — тот же, что у интерфейса (токен typography.fontFamily.sans). */
export interface PrintFont {
  family: string
}

export interface PrintTexts {
  title: string
  /** «19 сентября 2026 · Автор»; null — подпись не печатается. */
  signature: string | null
  /** Источники карты: подложка, данные; атрибуция OpenStreetMap — всегда. */
  attribution: string
  /** «Ещё N» — строки легенды, не поместившиеся на лист. */
  more: (count: number) => string
  /** Подпись линейки: «500 м», «2 км». */
  distance: (meters: number) => string
  /** Буква севера. */
  north: string
}

type ItemSwatch = Exclude<LegendSwatch, { kind: 'heatmap-gradient' }>

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Текст в ширину с многоточием. */
function fitText(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text
  const ellipsis = '…'
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (context.measureText(text.slice(0, middle) + ellipsis).width <= width) low = middle
    else high = middle - 1
  }
  return text.slice(0, low).trimEnd() + ellipsis
}

/** Текст в несколько строк шириной `width`; последняя — с многоточием. */
function wrap(
  context: CanvasRenderingContext2D,
  text: string,
  width: number,
  lines: number,
): string[] {
  const out: string[] = []
  let current = ''
  const words = text.split(/\s+/).filter(Boolean)
  for (let index = 0; index < words.length; index++) {
    const word = words[index] as string
    const next = current ? `${current} ${word}` : word
    if (context.measureText(next).width <= width || !current) {
      current = next
      continue
    }
    out.push(current)
    current = word
    if (out.length === lines - 1) {
      current = words.slice(index).join(' ')
      break
    }
  }
  if (current) out.push(fitText(context, current, width))
  return out.slice(0, lines)
}

/** Значки точек легенды — картинками их цвета (загружаются заранее: рисование синхронное). */
export async function loadLegendIcons(
  rows: readonly LegendRow[],
): Promise<Map<string, HTMLImageElement>> {
  const icons = new Map<string, HTMLImageElement>()
  await Promise.all(
    rows.map(async (row) => {
      if (row.kind !== 'item' || row.swatch.kind !== 'point') return
      const { icon, color, shape } = row.swatch
      if (shape !== 'icon' || !icon) return
      const key = `${icon}:${color}`
      if (icons.has(key)) return
      const image = await mapIconImage(icon, color).catch(() => null)
      if (image) icons.set(key, image)
    }),
  )
  return icons
}

function drawShape(
  context: CanvasRenderingContext2D,
  shape: string,
  cx: number,
  cy: number,
  size: number,
) {
  context.beginPath()
  if (shape === 'square') {
    context.rect(cx - size / 2, cy - size / 2, size, size)
  } else if (shape === 'triangle') {
    context.moveTo(cx, cy - size / 2)
    context.lineTo(cx + size / 2, cy + size / 2)
    context.lineTo(cx - size / 2, cy + size / 2)
    context.closePath()
  } else {
    context.arc(cx, cy, size / 2, 0, Math.PI * 2)
  }
}

/** Образец строки легенды — те же формы, что у `MapLegend` дизайн-системы. */
function drawSwatch(
  context: CanvasRenderingContext2D,
  swatch: ItemSwatch,
  x: number,
  cy: number,
  column: number,
  icons: ReadonlyMap<string, HTMLImageElement>,
) {
  const cx = x + column / 2
  context.save()
  switch (swatch.kind) {
    case 'fill':
      context.globalAlpha = swatch.opacity
      context.fillStyle = swatch.color
      context.beginPath()
      context.roundRect(cx - 8, cy - 6, 16, 12, 2)
      context.fill()
      if (swatch.outline) {
        context.globalAlpha = 1
        context.strokeStyle = swatch.outline
        context.lineWidth = clamp(swatch.outlineWidth, 1, 2)
        context.stroke()
      }
      break
    case 'line': {
      const width = clamp(swatch.width, 1, 10)
      context.globalAlpha = swatch.opacity
      context.strokeStyle = swatch.color
      context.lineWidth = width
      context.lineCap = swatch.dash ? 'butt' : 'round'
      context.setLineDash(swatch.dash ? swatch.dash.map((d) => d * width) : [])
      context.beginPath()
      context.moveTo(cx - 10, cy)
      context.lineTo(cx + 10, cy)
      context.stroke()
      break
    }
    case 'point': {
      const size = clamp(swatch.size, swatch.shape === 'icon' ? 14 : 6, 16)
      const icon = swatch.icon ? icons.get(`${swatch.icon}:${swatch.color}`) : undefined
      if (swatch.shape === 'icon' && icon) {
        context.drawImage(icon, cx - size / 2, cy - size / 2, size, size)
        break
      }
      drawShape(context, swatch.shape, cx, cy, size)
      context.globalAlpha = swatch.opacity
      context.fillStyle = swatch.color
      context.fill()
      context.globalAlpha = 1
      context.strokeStyle = swatch.outline
      context.lineWidth = 1
      context.stroke()
      break
    }
    case 'proportional-circle': {
      const size = clamp((swatch.size / Math.max(swatch.maxSize, 1)) * 16, 3, 16)
      drawShape(context, 'circle', cx, cy, size)
      context.globalAlpha = swatch.opacity * 0.85
      context.fillStyle = swatch.color
      context.fill()
      context.globalAlpha = 1
      context.strokeStyle = swatch.outline
      context.lineWidth = 1
      context.stroke()
      break
    }
    case 'cluster': {
      drawShape(context, 'circle', cx, cy, 16)
      context.fillStyle = swatch.color
      context.fill()
      context.strokeStyle = swatch.outline
      context.lineWidth = 1.5
      context.stroke()
      context.fillStyle = swatch.text
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.font = context.font.replace(/\d+(\.\d+)?px/, '8px')
      context.fillText(swatch.count, cx, cy + 0.5)
      break
    }
  }
  context.restore()
}

/** Легенда видимых слоёв по колонкам прямоугольника; не поместившееся — «ещё N». */
function drawLegend(
  context: CanvasRenderingContext2D,
  rows: readonly LegendRow[],
  rect: Rect,
  columnWidth: number,
  font: PrintFont,
  palette: PrintPalette,
  texts: PrintTexts,
  icons: ReadonlyMap<string, HTMLImageElement>,
) {
  // Не поместилось всё — строка «ещё N» внизу занимает место одной строки
  const reserve = 16
  const whole = flowLegend(rows, rect, columnWidth)
  const flow =
    whole.hidden > 0 ? flowLegend(rows, { ...rect, h: rect.h - reserve }, columnWidth) : whole
  const swatchColumn = 24
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  for (const { row, x, y, w } of flow.placed) {
    switch (row.kind) {
      case 'layer':
        context.font = `600 12px ${font.family}`
        context.fillStyle = palette.text
        context.fillText(fitText(context, row.text, w), x, y + 11)
        break
      case 'section':
        context.font = `500 10px ${font.family}`
        context.fillStyle = palette.secondary
        context.fillText(fitText(context, row.text, w), x, y + 8)
        break
      case 'item':
        drawSwatch(context, row.swatch, x, y + 9, swatchColumn, icons)
        context.font = `400 10px ${font.family}`
        context.fillStyle = palette.secondary
        context.fillText(
          fitText(context, row.text, w - swatchColumn - 6),
          x + swatchColumn + 6,
          y + 9,
        )
        break
      case 'gradient': {
        context.font = `400 10px ${font.family}`
        context.fillStyle = palette.secondary
        if (row.text) context.fillText(fitText(context, row.text, w), x, y + 7)
        const gradient = context.createLinearGradient(x, 0, x + w, 0)
        for (const stop of row.swatch.stops) gradient.addColorStop(stop.offset, stop.color)
        context.fillStyle = gradient
        context.beginPath()
        context.roundRect(x, y + 14, w, 8, 2)
        context.fill()
        context.fillStyle = palette.muted
        context.fillText(fitText(context, row.swatch.low, w / 2), x, y + 29)
        context.textAlign = 'right'
        context.fillText(fitText(context, row.swatch.high, w / 2), x + w, y + 29)
        context.textAlign = 'left'
        break
      }
      case 'note':
        context.font = `italic 400 10px ${font.family}`
        context.fillStyle = palette.muted
        context.fillText(fitText(context, row.text, w), x, y + 8)
        break
    }
  }
  if (flow.hidden > 0) {
    context.font = `400 10px ${font.family}`
    context.fillStyle = palette.muted
    context.fillText(texts.more(flow.hidden), rect.x, rect.y + rect.h - reserve / 2)
  }
}

/** Стрелка севера в круге: повёрнута вместе с картой. */
function drawNorth(
  context: CanvasRenderingContext2D,
  map: Rect,
  bearing: number,
  font: PrintFont,
  palette: PrintPalette,
  north: string,
) {
  const cx = map.x + map.w - 28
  const cy = map.y + 30
  context.save()
  context.fillStyle = palette.surface
  context.globalAlpha = 0.92
  context.beginPath()
  context.arc(cx, cy, 18, 0, Math.PI * 2)
  context.fill()
  context.globalAlpha = 1
  context.strokeStyle = palette.border
  context.lineWidth = 1
  context.stroke()
  context.translate(cx, cy)
  context.rotate((-bearing * Math.PI) / 180)
  // Левая половина стрелки залита, правая — контуром: читается и в ч/б печати
  context.fillStyle = palette.text
  context.beginPath()
  context.moveTo(0, -4)
  context.lineTo(-5, 12)
  context.lineTo(0, 9)
  context.closePath()
  context.fill()
  context.strokeStyle = palette.text
  context.beginPath()
  context.moveTo(0, -4)
  context.lineTo(5, 12)
  context.lineTo(0, 9)
  context.closePath()
  context.stroke()
  context.font = `600 10px ${font.family}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(north, 0, -11)
  context.restore()
}

/** Масштабная линейка в левом нижнем углу карты. */
function drawScale(
  context: CanvasRenderingContext2D,
  map: Rect,
  metersPerPixel: number,
  font: PrintFont,
  palette: PrintPalette,
  texts: PrintTexts,
) {
  const bar = scaleBar(metersPerPixel, Math.min(140, map.w / 4))
  if (!bar) return
  const x = map.x + 10
  const y = map.y + map.h - 10
  const label = texts.distance(bar.meters)
  context.save()
  context.font = `500 10px ${font.family}`
  const box = Math.max(bar.width, context.measureText(label).width) + 16
  context.fillStyle = palette.surface
  context.globalAlpha = 0.88
  context.fillRect(x, y - 30, box, 30)
  context.globalAlpha = 1
  context.strokeStyle = palette.text
  context.lineWidth = 1.5
  context.beginPath()
  context.moveTo(x + 8, y - 12)
  context.lineTo(x + 8, y - 7)
  context.lineTo(x + 8 + bar.width, y - 7)
  context.lineTo(x + 8 + bar.width, y - 12)
  context.stroke()
  context.fillStyle = palette.text
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.fillText(label, x + 8, y - 16)
  context.restore()
}

/**
 * Лист печати на холсте (07-gis-engine.md §13, ADR-0074): заголовок, кадр
 * карты, стрелка севера и масштаб поверх него, легенда видимых слоёв, подвал
 * с атрибуцией источников (OpenStreetMap — всегда) и подписью «дата · автор».
 */
export function composePrint(input: {
  layout: PrintLayout
  options: PrintOptions
  snapshot: MapSnapshot
  rows: readonly LegendRow[]
  texts: PrintTexts
  palette: PrintPalette
  font: PrintFont
  icons: ReadonlyMap<string, HTMLImageElement>
}): HTMLCanvasElement {
  const { layout, options, snapshot, texts, palette, font } = input
  const canvas = document.createElement('canvas')
  canvas.width = layout.page.width
  canvas.height = layout.page.height
  const context = canvas.getContext('2d')
  if (!context) return canvas
  context.scale(layout.unit, layout.unit)
  context.fillStyle = palette.surface
  context.fillRect(0, 0, layout.logical.width, layout.logical.height)

  if (layout.header) {
    context.font = `600 18px ${font.family}`
    context.fillStyle = palette.text
    context.textBaseline = 'middle'
    context.fillText(
      fitText(context, texts.title, layout.header.w),
      layout.header.x,
      layout.header.y + layout.header.h / 2,
    )
  }

  const { map } = layout
  context.drawImage(snapshot.canvas, map.x, map.y, map.w, map.h)
  context.strokeStyle = palette.border
  context.lineWidth = 1
  context.strokeRect(map.x + 0.5, map.y + 0.5, map.w - 1, map.h - 1)
  if (options.north) drawNorth(context, map, snapshot.bearing, font, palette, texts.north)
  if (options.scaleBar) {
    drawScale(context, map, snapshot.metersPerPixel, font, palette, texts)
  }

  if (layout.legend && input.rows.length > 0) {
    const beside = layout.legend.x > map.x + map.w
    drawLegend(
      context,
      input.rows,
      layout.legend,
      beside ? layout.legend.w : PRINT_METRICS.legendBandColumn,
      font,
      palette,
      texts,
      input.icons,
    )
  }

  const { footer } = layout
  context.textBaseline = 'top'
  context.font = `400 9px ${font.family}`
  let signatureWidth = 0
  if (options.signature && texts.signature) {
    context.fillStyle = palette.secondary
    context.textAlign = 'right'
    const signature = fitText(context, texts.signature, footer.w / 2)
    signatureWidth = context.measureText(signature).width + 16
    context.fillText(signature, footer.x + footer.w, footer.y + 4)
  }
  context.textAlign = 'left'
  context.fillStyle = palette.muted
  const lines = wrap(context, texts.attribution, footer.w - signatureWidth, 2)
  lines.forEach((line, index) => {
    context.fillText(line, footer.x, footer.y + 4 + index * 12)
  })
  return canvas
}
