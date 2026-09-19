import type { LegendItem, LegendModel, LegendSection, LegendSwatch } from '@kchs/map-style'
import { type ReactNode, useId } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

export interface MapLegendProps {
  legend: LegendModel
  className?: string
  /**
   * Значок точки по имени из набора значков карты (тот же, что MapView отдаёт
   * MapLibre SDF-изображениями). Без него значок рисуется кружком его цвета.
   */
  renderIcon?: (name: string, color: string, size: number) => ReactNode
}

/** Образцы крупнее не рисуются: легенда — справка, а не вторая карта. */
const MAX_SWATCH = 32
/** Точка мельче не различима, значок — тем более; узкие образцы — по центру колонки. */
const MIN_POINT = 6
const MIN_ICON = 14
const COLUMN = 16

function pointSize(swatch: Extract<LegendSwatch, { kind: 'point' }>): number {
  const iconic = swatch.shape === 'icon' && swatch.icon !== null
  return clamp(swatch.size, iconic ? MIN_ICON : MIN_POINT, MAX_SWATCH)
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Легенда слоя карты (07-gis-engine.md §4, ADR-0065): модель строит компилятор
 * `@kchs/map-style` из тех же классов, категорий и правил, что и слои MapLibre,
 * поэтому образцы совпадают с картой цвет в цвет. Компонент дизайн-системы, не
 * встроенный в карту: панель слоёв, всплывающая легенда, печать.
 */
export function MapLegend({ legend, className, renderIcon }: MapLegendProps) {
  const t = useUiT()
  if (!legend.show) return null
  return (
    <section
      aria-label={legend.title ?? t('ui.map.legend.title')}
      className={cn('flex min-w-0 flex-col gap-2 text-xs', className)}
    >
      {legend.title ? <p className="font-medium text-fg">{legend.title}</p> : null}
      {legend.sections.map((section) => (
        <Section key={section.id} section={section} renderIcon={renderIcon} />
      ))}
      {legend.note ? <p className="text-fg-muted">{legend.note}</p> : null}
    </section>
  )
}

function Section({
  section,
  renderIcon,
}: {
  section: LegendSection
  renderIcon: MapLegendProps['renderIcon']
}) {
  // Колонка образцов одной ширины: подписи выравниваются по левому краю
  const width = Math.max(COLUMN, ...section.items.map((item) => swatchWidth(item.swatch)))
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {section.title ? <p className="text-fg-secondary">{section.title}</p> : null}
      <ul className="flex min-w-0 flex-col gap-1">
        {section.items.map((item) =>
          item.swatch.kind === 'heatmap-gradient' ? (
            <Gradient key={item.id} item={item} swatch={item.swatch} />
          ) : (
            <li key={item.id} className="flex min-h-5 min-w-0 items-center gap-2">
              <span className="flex shrink-0 items-center justify-center" style={{ width }}>
                <Swatch swatch={item.swatch} renderIcon={renderIcon} />
              </span>
              <span className="min-w-0 truncate text-fg-secondary tabular">{item.label}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  )
}

function swatchWidth(swatch: LegendSwatch): number {
  switch (swatch.kind) {
    case 'fill':
      return 16
    case 'line':
      return 24
    case 'point':
      return pointSize(swatch) + 2
    case 'proportional-circle':
      return proportionalSize(swatch.maxSize, swatch.maxSize) + 2
    case 'cluster':
      return clamp(swatch.size, 20, MAX_SWATCH) + 4
    case 'heatmap-gradient':
      return 0
  }
}

/** Кружки размера — в масштабе, если самый крупный больше колонки образцов. */
function proportionalSize(size: number, maxSize: number): number {
  const scale = maxSize > MAX_SWATCH + 16 ? (MAX_SWATCH + 16) / maxSize : 1
  return Math.max(2, size * scale)
}

function Swatch({
  swatch,
  renderIcon,
}: {
  swatch: Exclude<LegendSwatch, { kind: 'heatmap-gradient' }>
  renderIcon: MapLegendProps['renderIcon']
}) {
  switch (swatch.kind) {
    case 'fill':
      return (
        <svg width={16} height={12} viewBox="0 0 16 12" aria-hidden="true">
          <rect
            x={0.5}
            y={0.5}
            width={15}
            height={11}
            rx={2}
            fill={swatch.color}
            fillOpacity={swatch.opacity}
            stroke={swatch.outline ?? 'none'}
            strokeWidth={swatch.outline ? clamp(swatch.outlineWidth, 1, 2) : 0}
          />
        </svg>
      )
    case 'line': {
      const width = clamp(swatch.width, 1, 10)
      const height = Math.max(12, width + 2)
      return (
        <svg width={24} height={height} viewBox={`0 0 24 ${height}`} aria-hidden="true">
          <line
            x1={2}
            y1={height / 2}
            x2={22}
            y2={height / 2}
            stroke={swatch.color}
            strokeOpacity={swatch.opacity}
            strokeWidth={width}
            strokeLinecap={swatch.dash ? 'butt' : 'round'}
            // Штрихи MapLibre — в ширинах линии
            strokeDasharray={swatch.dash?.map((d) => d * width).join(' ')}
          />
        </svg>
      )
    }
    case 'point': {
      const size = pointSize(swatch)
      const icon =
        swatch.shape === 'icon' && swatch.icon
          ? renderIcon?.(swatch.icon, swatch.color, size)
          : null
      if (icon) return <span aria-hidden="true">{icon}</span>
      return (
        <svg
          width={size + 2}
          height={size + 2}
          viewBox={`0 0 ${size + 2} ${size + 2}`}
          aria-hidden="true"
        >
          <Shape
            shape={swatch.shape}
            size={size}
            fill={swatch.color}
            stroke={swatch.outline}
            opacity={swatch.opacity}
          />
        </svg>
      )
    }
    case 'proportional-circle': {
      const size = proportionalSize(swatch.size, swatch.maxSize)
      return (
        <svg
          width={size + 2}
          height={size + 2}
          viewBox={`0 0 ${size + 2} ${size + 2}`}
          aria-hidden="true"
        >
          <circle
            cx={size / 2 + 1}
            cy={size / 2 + 1}
            r={size / 2}
            fill={swatch.color}
            fillOpacity={swatch.opacity * 0.85}
            stroke={swatch.outline}
            strokeWidth={1}
          />
        </svg>
      )
    }
    case 'cluster': {
      const size = clamp(swatch.size, 20, MAX_SWATCH)
      const center = size / 2 + 2
      return (
        <svg
          width={size + 4}
          height={size + 4}
          viewBox={`0 0 ${size + 4} ${size + 4}`}
          aria-hidden="true"
        >
          <circle
            cx={center}
            cy={center}
            r={size / 2}
            fill={swatch.color}
            stroke={swatch.outline}
            strokeWidth={2}
          />
          <text
            x={center}
            y={center}
            textAnchor="middle"
            dominantBaseline="central"
            fill={swatch.text}
            className="text-2xs font-semibold"
          >
            {swatch.count}
          </text>
        </svg>
      )
    }
  }
}

function Shape({
  shape,
  size,
  fill,
  stroke,
  opacity,
}: {
  shape: 'circle' | 'square' | 'triangle' | 'icon'
  size: number
  fill: string
  stroke: string
  opacity: number
}) {
  const props = { fill, fillOpacity: opacity, stroke, strokeWidth: 1 }
  if (shape === 'square') return <rect x={1} y={1} width={size} height={size} rx={1} {...props} />
  if (shape === 'triangle') {
    const top = `${size / 2 + 1},1`
    return <polygon points={`${top} ${size + 1},${size + 1} 1,${size + 1}`} {...props} />
  }
  return <circle cx={size / 2 + 1} cy={size / 2 + 1} r={size / 2} {...props} />
}

/** Тепловая карта: градиент плотности во всю ширину, подписи краёв под ним. */
function Gradient({
  item,
  swatch,
}: {
  item: LegendItem
  swatch: Extract<LegendSwatch, { kind: 'heatmap-gradient' }>
}) {
  const id = `map-legend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <li className="flex min-w-0 flex-col gap-1">
      {item.label ? <span className="text-fg-secondary">{item.label}</span> : null}
      <svg
        className="h-2.5 w-full"
        preserveAspectRatio="none"
        viewBox="0 0 100 10"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
            {swatch.stops.map((stop) => (
              <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={100} height={10} rx={2} fill={`url(#${id})`} />
      </svg>
      <span className="flex justify-between gap-2 text-fg-muted">
        <span>{swatch.low}</span>
        <span>{swatch.high}</span>
      </span>
    </li>
  )
}
