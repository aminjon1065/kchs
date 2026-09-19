import type { LayerStyle, StyleRenderer } from '@kchs/contracts'
import { INTL_LOCALE } from '@kchs/i18n'
import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec'
import { normalizeHex, readableOn, withAlpha } from './color.js'
import { DEFAULT_FONTS, MAP_IMAGE_SIZE, StyleState } from './context.js'
import { Encoder, type Encoding } from './encoding.js'
import {
  all,
  type Condition,
  condition,
  type Expr,
  expr,
  get,
  isNull,
  not,
  num,
  type Plan,
  planExpr,
  present,
  str,
} from './expr.js'
import { CLUSTER_COUNT_FIELD, templateFields } from './fields.js'
import type {
  CompiledLayerStyle,
  LegendItem,
  LegendModel,
  LegendSection,
  MapStyleContext,
} from './model.js'
import { deriveOutline, paletteColors } from './palette.js'

type Heatmap = Extract<StyleRenderer, { kind: 'heatmap' }>

/** Роль слоя MapLibre в `metadata['kchs:role']`: MapView выбирает по ней объекты для щелчка. */
export type LayerRole =
  | 'fill'
  | 'outline'
  | 'line'
  | 'point'
  | 'heatmap'
  | 'cluster'
  | 'cluster-count'
  | 'label'

const NUMBER_TYPES = new Set(['integer', 'number', 'decimal', 'money', 'rollup', 'duration'])
const TEMPLATE_PART = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g

/**
 * LayerStyle → слои MapLibre и легенда (контракт `layer-style.md`, ADR-0065).
 *
 * Слои — снизу вверх: заливка и обводка полигонов, линии, тепловая карта, точки
 * (`circle`, а с фигурами и значками — `symbol` с SDF-изображениями из `images`),
 * кластеры сервера (`point_count`) с числом, подписи. Идентификаторы —
 * `<ctx.id>:<роль>`, роль — ещё и в `metadata['kchs:role']`. Легенда строится из
 * тех же классов, категорий и правил, что и выражения слоёв.
 */
export function compileLayerStyle(style: LayerStyle, ctx: MapStyleContext): CompiledLayerStyle {
  const state = new StyleState(style, ctx)
  const encoder = new Encoder(state)
  const encoding = encoder.encode()
  const builder = new LayerBuilder(state, encoding)
  const layers = builder.build()
  const sections: LegendSection[] = []
  const main = builder.heatmapItems ?? encoding.items
  if (main.length) sections.push({ id: 'main', title: null, items: main })
  if (encoding.sizes) sections.push({ id: 'size', ...encoding.sizes })
  if (builder.clusterItem)
    sections.push({ id: 'cluster', title: null, items: [builder.clusterItem] })
  const legend: LegendModel = {
    show: style.legend.show,
    title: state.text(style.legend.title) ?? encoding.title,
    sections,
    note: encoding.note,
  }
  return { layers, legend, images: state.imageList(), warnings: state.warnings }
}

class LayerBuilder {
  heatmapItems: LegendItem[] | null = null
  clusterItem: LegendItem | null = null
  private readonly style: LayerStyle
  private readonly ctx: MapStyleContext

  constructor(
    private readonly s: StyleState,
    private readonly e: Encoding,
  ) {
    this.style = s.style
    this.ctx = s.ctx
  }

  build(): LayerSpecification[] {
    const layers: LayerSpecification[] = []
    const renderer = this.style.renderer
    const heatmap = renderer.kind === 'heatmap' && this.s.geometry === 'point' ? renderer : null
    const clusters = this.s.geometry === 'point' && this.style.cluster?.enabled === true
    const features = this.featureFilter(clusters && !heatmap)

    if (heatmap) {
      layers.push(this.heatmap(heatmap, this.featureFilter(false), clusters))
    } else {
      switch (this.s.geometry) {
        case 'polygon':
          layers.push(...this.polygon(features))
          break
        case 'line':
          layers.push(this.line(features))
          break
        case 'point':
          layers.push(this.point(features))
          if (clusters) layers.push(...this.clusters())
          break
      }
    }
    const label = this.label(features)
    if (label) layers.push(label)
    return layers.map((layer) => this.zoom(layer))
  }

  // ─── Общее ─────────────────────────────────────────────────────────────────

  private base<R extends LayerRole>(role: R) {
    const sourceLayer = this.ctx.sourceLayer === undefined ? 'layer' : this.ctx.sourceLayer
    return {
      id: `${this.ctx.id}:${role}`,
      source: this.ctx.source,
      ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
      metadata: { 'kchs:layer': this.ctx.id, 'kchs:role': role },
    }
  }

  private withFilter<T extends object>(layer: T, filter: Condition): T {
    return filter === true ? layer : { ...layer, filter: condition(filter) }
  }

  /**
   * Диапазон зумов стиля включительно: слой виден и на уровне maxZoom, поэтому
   * `maxzoom` MapLibre (исключающий) — на единицу больше; от 22 — без ограничения.
   */
  private zoom(layer: LayerSpecification): LayerSpecification {
    const out = { ...layer } as LayerSpecification & { minzoom?: number; maxzoom?: number }
    const min = Math.max(this.style.minZoom, out.minzoom ?? 0)
    if (min > 0) out.minzoom = min
    else delete out.minzoom
    if (this.style.maxZoom < 22) out.maxzoom = this.style.maxZoom + 1
    return out
  }

  /**
   * Отбор объектов: фильтр слоя (только по запросу — обычно его применяет сервер),
   * свой отбор рендерера, кадр времени, без кластеров сервера.
   */
  private featureFilter(withoutClusters: boolean): Condition {
    const parts: Condition[] = []
    if (this.ctx.clientFilter && this.style.filter) {
      parts.push(this.s.filter(this.style.filter, 'over', 'filter'))
    }
    parts.push(this.e.filter)
    parts.push(this.timeFilter())
    if (withoutClusters) parts.push(not(this.isCluster()))
    return all(parts)
  }

  /** Кадр времени: момент — [from, to), интервал — [from, to], накопление — до `to`. */
  private timeFilter(): Condition {
    const time = this.style.time
    const frame = this.ctx.time
    if (!time || !frame) return true
    this.s.requireField(time.field, 'time.field')
    const t = num(time.field)
    const has = present(time.field)
    switch (time.mode) {
      case 'instant':
        return all([has, expr('>=', t, frame.from), expr('<', t, frame.to)])
      case 'range':
        return all([has, expr('>=', t, frame.from), expr('<=', t, frame.to)])
      case 'cumulative':
        return all([has, expr('<=', t, frame.to)])
    }
  }

  private isCluster(): Expr {
    return expr('>', num(CLUSTER_COUNT_FIELD), 1)
  }

  private colorExpr(): string | Expr {
    return planExpr(this.e.color, (color) => color)
  }

  private derivedOutline(): string | Expr {
    return planExpr(this.e.color, (color) => deriveOutline(color, this.s.theme))
  }

  private sizePlan(): Plan<number> {
    return (
      this.e.size ?? {
        kind: 'constant',
        value: this.s.geometry === 'line' ? this.style.line.width : this.style.point.size,
      }
    )
  }

  // ─── Геометрии ─────────────────────────────────────────────────────────────

  private polygon(filter: Condition): LayerSpecification[] {
    const { fillOpacity, outline } = this.style.polygon
    const layers: LayerSpecification[] = [
      this.withFilter(
        {
          ...this.base('fill'),
          type: 'fill',
          paint: {
            'fill-color': this.colorExpr(),
            'fill-opacity': round(fillOpacity * this.style.opacity),
          },
        } as LayerSpecification,
        filter,
      ),
    ]
    if (outline.width > 0) {
      const color =
        outline.color === 'auto'
          ? this.derivedOutline()
          : this.s.outline(outline.color, '#000000', 'polygon.outline.color')
      layers.push(
        this.withFilter(
          {
            ...this.base('outline'),
            type: 'line',
            layout: { 'line-join': 'round' },
            paint: {
              'line-color': color,
              'line-width': outline.width,
              'line-opacity': this.style.opacity,
            },
          } as LayerSpecification,
          filter,
        ),
      )
    }
    return layers
  }

  private line(filter: Condition): LayerSpecification {
    const { cap, dash } = this.style.line
    // Нечётный список штрихов повторяется дважды — как stroke-dasharray в SVG
    const dashes = dash?.some((d) => d > 0) ? (dash.length % 2 ? [...dash, ...dash] : dash) : null
    return this.withFilter(
      {
        ...this.base('line'),
        type: 'line',
        layout: { 'line-cap': cap, 'line-join': 'round' },
        paint: {
          'line-color': this.colorExpr(),
          'line-width': planExpr(this.sizePlan(), (width) => width),
          'line-opacity': this.style.opacity,
          ...(dashes ? { 'line-dasharray': dashes } : {}),
        },
      } as LayerSpecification,
      filter,
    )
  }

  /** Точки: кружки — слой `circle`, фигуры и значки — `symbol` с SDF-изображениями. */
  private point(filter: Condition): LayerSpecification {
    const opacity = this.style.opacity
    if (!this.e.image) {
      return this.withFilter(
        {
          ...this.base('point'),
          type: 'circle',
          paint: {
            'circle-color': this.colorExpr(),
            'circle-radius': planExpr(this.sizePlan(), (size) => round(size / 2)),
            'circle-opacity': opacity,
            'circle-stroke-color': this.derivedOutline(),
            'circle-stroke-width': 1,
            'circle-stroke-opacity': opacity,
          },
        } as LayerSpecification,
        filter,
      )
    }
    return this.withFilter(
      {
        ...this.base('point'),
        type: 'symbol',
        layout: {
          'icon-image': planExpr(this.e.image, (image) => image),
          'icon-size': planExpr(this.sizePlan(), (size) => round(size / MAP_IMAGE_SIZE)),
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': this.colorExpr(),
          'icon-opacity': opacity,
          'icon-halo-color': this.derivedOutline(),
          'icon-halo-width': 1,
        },
      } as LayerSpecification,
      filter,
    )
  }

  // ─── Тепловая карта ────────────────────────────────────────────────────────

  private heatmap(r: Heatmap, filter: Condition, clusters: boolean): LayerSpecification {
    const colors = paletteColors(this.s.theme, r.palette, 7)
    const first = colors[0] as string
    const density: unknown[] = [0, withAlpha(first, 0)]
    for (const [i, color] of colors.entries()) density.push(round((i + 1) / colors.length), color)
    let weight: number | Expr = 1
    if (r.weightField) {
      const domain = this.ctx.domains?.[r.weightField]
      if (domain && domain.max > domain.min) {
        weight = expr(
          'case',
          isNull(r.weightField),
          0,
          expr('interpolate', ['linear'], num(r.weightField), domain.min, 0, domain.max, 1),
        )
      } else if (!domain) {
        this.s.warn('domain-missing', 'renderer.weightField', r.weightField)
      }
    }
    // Кластер сервера — одна точка за многих: вес умножается на их число
    if (clusters) weight = expr('*', weight, expr('max', 1, num(CLUSTER_COUNT_FIELD)))
    this.heatmapItems = [
      {
        id: 'density',
        label: r.weightField
          ? this.s.t('ui.map.legend.weight', { field: this.s.fieldLabel(r.weightField) })
          : '',
        swatch: {
          kind: 'heatmap-gradient',
          stops: colors.map((color, i) => ({ offset: round(i / (colors.length - 1)), color })),
          low: this.s.t('ui.map.legend.low'),
          high: this.s.t('ui.map.legend.high'),
        },
      },
    ]
    return this.withFilter(
      {
        ...this.base('heatmap'),
        type: 'heatmap',
        paint: {
          'heatmap-weight': weight,
          'heatmap-intensity': r.intensity,
          'heatmap-radius': r.radius,
          'heatmap-color': expr('interpolate', ['linear'], ['heatmap-density'], ...density),
          'heatmap-opacity': this.style.opacity,
        },
      } as LayerSpecification,
      filter,
    )
  }

  // ─── Кластеры ──────────────────────────────────────────────────────────────

  /**
   * Кластеры сервера — точки с `point_count` > 1 (ST_SnapToGrid + count в SQL тайла):
   * кружок по логарифму числа точек и число внутри. Цвет — у простого стиля и размера
   * по значению основной, у классов и категорий — «прочее»: в кластере смешаны все.
   */
  private clusters(): LayerSpecification[] {
    const cluster = this.style.cluster
    if (!cluster) return []
    const theme = this.s.theme
    const kind = this.style.renderer.kind
    const color =
      this.e.color.kind === 'constant' && (kind === 'simple' || kind === 'proportional')
        ? this.e.color.value
        : normalizeHex(theme.other)
    const text = readableOn(color, normalizeHex(theme.text), normalizeHex(theme.surface))
    const { min, max } = cluster.style
    const maxCount = Math.max(10, this.ctx.domains?.[CLUSTER_COUNT_FIELD]?.max ?? 1000)
    const radius = expr(
      'interpolate',
      ['linear'],
      expr('log10', expr('max', 2, num(CLUSTER_COUNT_FIELD))),
      round(Math.log10(2)),
      round(min / 2),
      round(Math.log10(maxCount)),
      round(max / 2),
    )
    const opacity = this.style.opacity
    const isCluster = this.isCluster()
    this.clusterItem = {
      id: 'cluster',
      label: this.s.t('ui.map.legend.cluster'),
      swatch: {
        kind: 'cluster',
        color,
        outline: normalizeHex(theme.surface),
        text,
        size: Math.round((min + max) / 2),
        count: this.s.formatNumber(25, { precision: 0 }),
      },
    }
    return [
      {
        ...this.base('cluster'),
        type: 'circle',
        filter: isCluster,
        paint: {
          'circle-color': color,
          'circle-radius': radius,
          'circle-opacity': round(0.9 * opacity),
          'circle-stroke-color': normalizeHex(theme.surface),
          'circle-stroke-width': 2,
          'circle-stroke-opacity': opacity,
        },
      } as LayerSpecification,
      {
        ...this.base('cluster-count'),
        type: 'symbol',
        filter: isCluster,
        layout: {
          'text-field': this.countText(),
          'text-font': [...(this.ctx.fonts?.bold ?? DEFAULT_FONTS.bold)],
          'text-size': 11,
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': text, 'text-opacity': opacity },
      } as LayerSpecification,
    ]
  }

  /** Число точек кластера: до тысячи — полностью, дальше — «1,2 тыс.», «15 тыс.», «2,5 млн». */
  private countText(): Expr {
    const intl = INTL_LOCALE[this.s.locale]
    const count = num(CLUSTER_COUNT_FIELD)
    const format = (value: Expr, max: number) =>
      expr('number-format', value, { locale: intl, 'max-fraction-digits': fractionDigits(max) })
    const thousands = compactSuffix(intl, 1e3, ' K')
    const millions = compactSuffix(intl, 1e6, ' M')
    return expr(
      'case',
      expr('>=', count, 1e6),
      expr('concat', format(expr('/', count, 1e6), 1), millions),
      expr('>=', count, 1e4),
      expr('concat', format(expr('/', count, 1e3), 0), thousands),
      expr('>=', count, 1e3),
      expr('concat', format(expr('/', count, 1e3), 1), thousands),
      format(count, 0),
    )
  }

  // ─── Подписи ───────────────────────────────────────────────────────────────

  private label(filter: Condition): LayerSpecification | null {
    const label = this.style.label
    if (!label || (!label.field && !label.template)) return null
    const text = label.template
      ? this.template(label.template)
      : this.fieldText(label.field as string, 'label.field')
    const geometry = this.s.geometry
    let placement: 'point' | 'line' = geometry === 'line' ? 'line' : 'point'
    if (label.placement === 'point') placement = 'point'
    if (label.placement === 'line') {
      if (geometry === 'point') {
        this.s.warn('label-placement', 'label.placement', 'подпись точки — только у точки')
      } else placement = 'line'
    }
    const layout: Record<string, unknown> = {
      'text-field': text,
      'text-font': [...(this.ctx.fonts?.regular ?? DEFAULT_FONTS.regular)],
      'text-size': label.size,
      'symbol-placement': placement,
      'text-padding': 2,
    }
    if (placement === 'line') {
      layout['text-rotation-alignment'] = 'map'
      layout['text-max-angle'] = 30
    } else if (geometry === 'point') {
      // Подпись рядом с точкой: сверху, снизу, справа или слева — где помещается
      layout['text-variable-anchor'] = ['top', 'bottom', 'right', 'left']
      layout['text-radial-offset'] = planExpr(this.sizePlan(), (size) =>
        round((size / 2 + 2) / label.size),
      )
      layout['text-justify'] = 'auto'
    }
    const sortKey = this.sortKey(label.priority, label.field)
    if (sortKey) layout['symbol-sort-key'] = sortKey
    const layer = this.withFilter(
      {
        ...this.base('label'),
        type: 'symbol',
        minzoom: label.minZoom,
        layout,
        paint: {
          'text-color': normalizeHex(this.s.theme.text),
          'text-halo-color': normalizeHex(this.s.theme.surface),
          'text-halo-width': label.halo ? 1.5 : 0,
          'text-halo-blur': label.halo ? 0.5 : 0,
          'text-opacity': this.style.opacity,
        },
      } as LayerSpecification,
      filter,
    )
    return layer
  }

  /** Приоритет подписей: крупные (или с большим значением поля) ставятся первыми. */
  private sortKey(priority: 'size' | 'field' | 'none', field: string | null): Expr | null {
    if (priority === 'size' && this.e.sizeField) return expr('-', 0, num(this.e.sizeField))
    if (priority === 'field' && field && NUMBER_TYPES.has(this.s.field(field)?.type ?? '')) {
      return expr('-', 0, num(field))
    }
    return null
  }

  /** Шаблон `{{name}} ({{capacity}})`: поля — отформатированные значения, остальное — текст. */
  private template(template: string): string | Expr {
    const parts: Array<string | Expr> = []
    let last = 0
    for (const match of template.matchAll(TEMPLATE_PART)) {
      if (match.index > last) parts.push(template.slice(last, match.index))
      parts.push(this.fieldText(match[1] as string, 'label.template'))
      last = match.index + match[0].length
    }
    if (last < template.length) parts.push(template.slice(last))
    if (templateFields(template).length === 0) return template
    return parts.length === 1 ? (parts[0] as Expr) : expr('concat', ...parts)
  }

  /**
   * Значение поля в подписи: числа — `number-format` с языком и точностью поля,
   * варианты выбора — их подписи, «да/нет» — словами. Даты в тайле — числа
   * (мс эпохи), MapLibre их не форматирует: подпись по дате — замечание.
   */
  private fieldText(key: string, path: string): string | Expr {
    const field = this.s.requireField(key, path)
    const type = field?.type
    const intl = INTL_LOCALE[this.s.locale]
    if (type && (NUMBER_TYPES.has(type) || type === 'percent')) {
      const format = field?.format ?? {}
      const percent = type === 'percent'
      const precision = format.precision ?? (percent ? 1 : type === 'money' ? 2 : undefined)
      const options: Record<string, unknown> = { locale: intl }
      if (precision !== undefined) {
        options['min-fraction-digits'] = fractionDigits(precision)
        options['max-fraction-digits'] = fractionDigits(precision)
      }
      if (format.currency && !percent) options.currency = format.currency
      const value = percent && format.scale !== 'percent' ? expr('*', num(key), 100) : num(key)
      let body: Expr = expr('number-format', value, options)
      const prefix = format.prefix ?? ''
      const suffix = percent ? percentSuffix(intl) : (format.suffix ?? '')
      if (prefix || suffix) body = expr('concat', prefix, body, suffix)
      return expr('case', isNull(key), '', body)
    }
    if (type === 'boolean') {
      return expr(
        'case',
        expr('==', get(key), true),
        this.s.formatValue(true, key),
        expr('==', get(key), false),
        this.s.formatValue(false, key),
        '',
      )
    }
    if (type === 'date' || type === 'datetime') {
      this.s.warn('label-format', path, key)
      return ''
    }
    const options = field?.options ?? []
    if (options.length > 0) {
      const branches = options.flatMap((option) => [
        option.value,
        this.s.formatValue(option.value, key),
      ])
      return expr('match', str(key), ...branches, str(key))
    }
    return str(key)
  }
}

/** Сокращение тысяч и миллионов на языке интерфейса (« тыс.», «K») — как formatCompactNumber. */
function compactSuffix(locale: string, value: number, fallback: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 0,
    }).formatToParts(value)
    const index = parts.findIndex((part) => part.type === 'compact')
    if (index < 0) return fallback
    const literal = parts[index - 1]?.type === 'literal' ? (parts[index - 1]?.value ?? '') : ''
    return `${literal}${parts[index]?.value ?? ''}`
  } catch {
    return fallback
  }
}

/**
 * Число знаков для `number-format`: MapLibre пропускает ложные значения опций,
 * и литерал 0 не действовал бы (15,3 вместо 15) — ноль передаётся выражением.
 */
function fractionDigits(n: number): number | Expr {
  return n === 0 ? expr('literal', 0) : n
}

/** Знак процента с отбивкой языка («12,5 %», «12.5%») — как formatPercent платформы. */
function percentSuffix(locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: 'percent' }).formatToParts(0.5)
  const last = parts.findLastIndex((part) => part.type === 'integer' || part.type === 'fraction')
  return parts
    .slice(last + 1)
    .map((part) => part.value)
    .join('')
}

const round = (value: number): number => Number(value.toPrecision(6))
