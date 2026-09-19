import type { LayerStyle, StyleRenderer } from '@kchs/contracts'
import { classify } from './classify.js'
import { normalizeHex } from './color.js'
import type { StyleState } from './context.js'
import {
  all,
  any,
  type Condition,
  condition,
  type Expr,
  expr,
  get,
  isNull,
  num,
  type Plan,
  present,
  str,
} from './expr.js'
import type { LegendItem, LegendSwatch, PointShape } from './model.js'
import { deriveOutline, paletteColor, paletteColors } from './palette.js'

type Renderer<K extends StyleRenderer['kind']> = Extract<StyleRenderer, { kind: K }>

/** Как рисуются объекты: цвет, размер, изображение точки и свой отбор рендерера. */
export interface Encoding {
  color: Plan<string>
  /** Диаметр точки или ширина линии, px; null — из стиля (`point.size`, `line.width`). */
  size: Plan<number> | null
  /** Изображение точки (id SDF); null — все точки кружками (слой `circle`). */
  image: Plan<string> | null
  /** Отбор рендерера: «прочее» без цвета не рисуется, размер по пустому значению — тоже. */
  filter: Condition
  /** Поле, от которого зависит размер: приоритет подписей `size`. */
  sizeField: string | null
  title: string | null
  items: LegendItem[]
  /** Часть легенды «размер» — у размера по полю (`point.sizeBy`). */
  sizes: { title: string; items: LegendItem[] } | null
  note: string | null
}

interface Mark {
  shape: PointShape
  icon: string | null
}

const constant = <T extends string | number>(value: T): Plan<T> => ({ kind: 'constant', value })

/** Классы размера градуированного стиля: диаметр точки и ширина линии, px. */
const GRADUATED_POINT_SIZES = [6, 24] as const
const MAX_LINE_WIDTH = 20

export class Encoder {
  private readonly style: LayerStyle

  constructor(private readonly s: StyleState) {
    this.style = s.style
  }

  encode(): Encoding {
    const renderer = this.style.renderer
    let encoding: Encoding
    switch (renderer.kind) {
      case 'simple':
        encoding = this.simple(renderer)
        break
      case 'categorized':
        encoding = this.categorized(renderer)
        break
      case 'graduated':
        encoding = this.graduated(renderer)
        break
      case 'heatmap':
        encoding = this.heatmap(renderer)
        break
      case 'proportional':
        encoding = this.proportional(renderer)
        break
      case 'rule':
        encoding = this.rule(renderer)
        break
    }
    return this.withSizeBy(encoding)
  }

  // ─── Образцы легенды ───────────────────────────────────────────────────────

  /** Точка: значок из рендерера или стиля; `icon` без имени — кружок. */
  mark(icon?: string | null): Mark {
    if (icon) return { shape: 'icon', icon }
    const point = this.style.point
    if (point.shape === 'icon') {
      return point.icon ? { shape: 'icon', icon: point.icon } : { shape: 'circle', icon: null }
    }
    return { shape: point.shape, icon: null }
  }

  imageOf(mark: Mark): string {
    return mark.shape === 'icon' && mark.icon
      ? this.s.image('icon', mark.icon)
      : this.s.image('shape', mark.shape)
  }

  baseSize(): number {
    return this.s.geometry === 'line' ? this.style.line.width : this.style.point.size
  }

  swatch(color: string, size: number | null, mark: Mark = this.mark()): LegendSwatch {
    const style = this.style
    switch (this.s.geometry) {
      case 'polygon': {
        const outline = style.polygon.outline
        return {
          kind: 'fill',
          color,
          opacity: style.polygon.fillOpacity * style.opacity,
          outline:
            outline.width > 0
              ? this.s.outline(outline.color, color, 'polygon.outline.color')
              : null,
          outlineWidth: outline.width,
        }
      }
      case 'line':
        return {
          kind: 'line',
          color,
          width: size ?? style.line.width,
          dash: style.line.dash,
          opacity: style.opacity,
        }
      case 'point':
        return {
          kind: 'point',
          shape: mark.shape,
          color,
          outline: deriveOutline(color, this.s.theme),
          size: size ?? style.point.size,
          opacity: style.opacity,
          icon: mark.icon,
        }
    }
  }

  // ─── Рендереры ─────────────────────────────────────────────────────────────

  private simple(r: Renderer<'simple'>): Encoding {
    const color = this.s.color(r.color, 'renderer.color')
    const mark = this.mark(r.icon)
    const name = this.s.ctx.name?.trim()
    return {
      color: constant(color),
      size: null,
      image:
        this.s.geometry === 'point' && mark.shape !== 'circle'
          ? constant(this.imageOf(mark))
          : null,
      filter: true,
      sizeField: null,
      title: null,
      items: [
        {
          id: 'simple',
          label: name || this.s.t('ui.map.legend.objects'),
          swatch: this.swatch(color, null, mark),
        },
      ],
      sizes: null,
      note: null,
    }
  }

  private categorized(r: Renderer<'categorized'>): Encoding {
    const key = r.field
    const field = this.s.requireField(key, 'renderer.field')
    const numeric =
      field && NUMBER_TYPES.has(field.type)
        ? true
        : !field && r.categories.some((c) => typeof c.value === 'number')
    const boolean =
      field?.type === 'boolean' ||
      (!field && r.categories.some((c) => typeof c.value === 'boolean'))
    const kind: ValueKind = boolean ? 'boolean' : numeric ? 'number' : 'text'

    const seen = new Set<string>()
    const categories: Array<Category> = []
    r.categories.forEach((category, index) => {
      const value = normalizeValue(category.value, kind)
      const signature = JSON.stringify(value)
      if (seen.has(signature)) {
        this.s.warn('category-duplicate', `renderer.categories.${index}.value`, signature)
        return
      }
      seen.add(signature)
      categories.push({
        value,
        index,
        color: this.s.color(category.color, `renderer.categories.${index}.color`),
        size: category.size ?? null,
        icon: category.icon ?? null,
        label: this.s.text(category.label) ?? this.s.formatValue(value, key),
      })
    })
    const other = r.other ? this.s.color(r.other.color, 'renderer.other.color') : null
    const fallbackColor = other ?? normalizeHex(this.s.theme.other)
    const matcher = new CategoryMatcher(key, kind, categories)

    const geometry = this.s.geometry
    const sized = geometry !== 'polygon' && categories.some((c) => c.size !== null)
    const pictured =
      geometry === 'point' &&
      (this.mark().shape !== 'circle' || categories.some((c) => c.icon !== null))

    const items: LegendItem[] = categories.map((c) => ({
      id: `category-${c.index}`,
      label: c.label,
      swatch: this.swatch(c.color, sized ? (c.size ?? this.baseSize()) : null, this.mark(c.icon)),
    }))
    if (other) {
      items.push({
        id: 'other',
        label: this.s.text(r.other?.label) ?? this.s.t('ui.map.legend.other'),
        swatch: this.swatch(other, null),
      })
    }
    return {
      color: matcher.plan((c) => c.color, fallbackColor),
      size: sized ? matcher.plan((c) => c.size ?? this.baseSize(), this.baseSize()) : null,
      image: pictured
        ? matcher.plan((c) => this.imageOf(this.mark(c.icon)), this.imageOf(this.mark()))
        : null,
      filter: other ? true : matcher.anyCategory(),
      sizeField: null,
      title: this.s.fieldLabel(key),
      items,
      sizes: null,
      note: null,
    }
  }

  private graduated(r: Renderer<'graduated'>): Encoding {
    const key = r.field
    const field = this.s.requireField(key, 'renderer.field')
    if (r.normalizeBy) this.s.requireField(r.normalizeBy, 'renderer.normalizeBy')
    const edges =
      r.method === 'manual'
        ? classify([], 'manual', r.classes, { breaks: r.breaks })
        : classify([], 'manual', r.classes, { breaks: this.s.ctx.breaks ?? r.breaks })
    const title = r.normalizeBy
      ? this.s.t('ui.map.legend.ratio', {
          field: this.s.fieldLabel(key),
          by: this.s.fieldLabel(r.normalizeBy),
        })
      : this.s.fieldLabel(key)

    let target = r.visual.target
    if (target !== 'fill' && this.s.geometry === 'polygon') {
      this.s.warn('renderer-geometry', 'renderer.visual.target', 'размер классов — у точек и линий')
      target = 'fill'
    }

    if (edges.length < 2) {
      this.s.warn('breaks-missing', r.method === 'manual' ? 'renderer.breaks' : 'renderer')
      const color = paletteColor(this.s.theme, r.palette)
      return {
        color: constant(color),
        size: null,
        image: this.pointImage(),
        filter: true,
        sizeField: null,
        title,
        items: [],
        sizes: null,
        note: this.s.t('ui.map.legend.noBreaks'),
      }
    }

    const value: Expr = r.normalizeBy ? expr('/', num(key), num(r.normalizeBy)) : num(key)
    const missing = condition(
      r.normalizeBy
        ? any([isNull(key), isNull(r.normalizeBy), expr('==', num(r.normalizeBy), 0)])
        : isNull(key),
    )
    const count = edges.length - 1
    const colors = paletteColors(this.s.theme, r.palette, count)
    const noData = normalizeHex(this.s.theme.other)
    const [low, high] =
      this.s.geometry === 'line'
        ? [this.style.line.width, Math.min(MAX_LINE_WIDTH, this.style.line.width * 4)]
        : GRADUATED_POINT_SIZES
    const sizes = Array.from({ length: count }, (_, i) =>
      count === 1 ? (low + high) / 2 : round2(low + ((high - low) * i) / (count - 1)),
    )
    const colored = target !== 'size'
    const sized = target !== 'fill'
    const single = paletteColor(this.s.theme, r.palette)

    const step = <T extends string | number>(values: readonly T[], none: T): Plan<T> => ({
      kind: 'step',
      input: value,
      base: values[0] as T,
      stops: edges.slice(1, -1).map((at, i) => ({ at, value: values[i + 1] as T })),
      missing: { when: missing, value: none },
    })

    // Отношение (нормализация) — уже не единицы поля: формат поля к нему не применим
    const measure = this.s.measure(
      r.normalizeBy ? null : key,
      this.style.legend.format ?? (r.normalizeBy ? null : field?.format),
      edges,
    )
    const items: LegendItem[] = colors.map((color, i) => ({
      id: `class-${i + 1}`,
      label: rangeLabel(this.s, measure, edges[i] as number, edges[i + 1] as number),
      swatch: this.swatch(colored ? color : single, sized ? (sizes[i] as number) : null),
    }))
    if ((this.s.ctx.domains?.[key]?.nulls ?? 0) > 0) {
      items.push({
        id: 'no-data',
        label: this.s.t('ui.map.legend.noData'),
        swatch: this.swatch(noData, sized ? low : null),
      })
    }
    return {
      color: colored ? step(colors, noData) : constant(single),
      size: sized ? step(sizes, low) : null,
      image: this.pointImage(),
      filter: true,
      sizeField: sized ? key : null,
      title,
      items,
      sizes: null,
      note: null,
    }
  }

  /** Тепловая карта рисует только точки; линии и полигоны — простым стилем цвета палитры. */
  private heatmap(r: Renderer<'heatmap'>): Encoding {
    if (r.weightField) this.s.requireField(r.weightField, 'renderer.weightField')
    const color = paletteColor(this.s.theme, r.palette)
    if (this.s.geometry !== 'point') {
      this.s.warn('renderer-geometry', 'renderer.kind', 'тепловая карта — только для точек')
      return this.simple({ kind: 'simple', color, icon: null })
    }
    return {
      color: constant(color),
      size: null,
      image: null,
      filter: true,
      sizeField: null,
      title: this.s.t('ui.map.legend.density'),
      items: [],
      sizes: null,
      note: null,
    }
  }

  private proportional(r: Renderer<'proportional'>): Encoding {
    const key = r.field
    const field = this.s.requireField(key, 'renderer.field')
    const color = this.s.color(r.color, 'renderer.color')
    const title = this.s.fieldLabel(key)
    if (this.s.geometry === 'polygon') {
      this.s.warn('renderer-geometry', 'renderer.kind', 'размер по значению — у точек и линий')
      return this.simple({ kind: 'simple', color: r.color, icon: null })
    }
    const [min, max] =
      this.s.geometry === 'line'
        ? [Math.min(r.min, MAX_LINE_WIDTH), Math.min(r.max, MAX_LINE_WIDTH)]
        : [r.min, r.max]
    const scaled = this.scale(key, 'renderer.field', min, max, r.scale)
    const measure = this.s.measure(key, this.style.legend.format ?? field?.format, scaled.samples)
    return {
      color: constant(color),
      size: scaled.plan,
      image: this.pointImage(),
      filter: present(key),
      sizeField: key,
      title,
      items: this.sizeItems(color, scaled, measure, 'size'),
      sizes: null,
      note: null,
    }
  }

  private rule(r: Renderer<'rule'>): Encoding {
    const rules = r.rules.map((rule, index) => ({
      index,
      when: this.s.filter(rule.filter, 'under', `renderer.rules.${index}.filter`),
      color: this.s.color(rule.color, `renderer.rules.${index}.color`),
      size: rule.size ?? null,
      icon: rule.icon ?? null,
      label: this.s.text(rule.label) ?? this.s.t('ui.map.legend.rule', { n: index + 1 }),
    }))
    const other = r.other ? this.s.color(r.other.color, 'renderer.other.color') : null
    const fallbackColor = other ?? normalizeHex(this.s.theme.other)
    const geometry = this.s.geometry
    const sized = geometry !== 'polygon' && rules.some((rule) => rule.size !== null)
    const pictured =
      geometry === 'point' &&
      (this.mark().shape !== 'circle' || rules.some((rule) => rule.icon !== null))
    // Первое подходящее правило — его цвет: порядок правил — приоритет
    const plan = <T extends string | number>(
      pick: (rule: (typeof rules)[number]) => T,
      fallback: T,
    ) =>
      ({
        kind: 'case',
        cases: rules
          .filter((rule) => rule.when !== false)
          .map((rule) => ({ when: condition(rule.when), value: pick(rule) })),
        fallback,
      }) satisfies Plan<T>

    const items: LegendItem[] = rules.map((rule) => ({
      id: `rule-${rule.index}`,
      label: rule.label,
      swatch: this.swatch(
        rule.color,
        sized ? (rule.size ?? this.baseSize()) : null,
        this.mark(rule.icon),
      ),
    }))
    if (other) {
      items.push({
        id: 'other',
        label: this.s.text(r.other?.label) ?? this.s.t('ui.map.legend.other'),
        swatch: this.swatch(other, null),
      })
    }
    return {
      color: plan((rule) => rule.color, fallbackColor),
      size: sized ? plan((rule) => rule.size ?? this.baseSize(), this.baseSize()) : null,
      image: pictured
        ? plan((rule) => this.imageOf(this.mark(rule.icon)), this.imageOf(this.mark()))
        : null,
      filter: other ? true : any(rules.map((rule) => rule.when)),
      sizeField: null,
      title: null,
      items,
      sizes: null,
      note: null,
    }
  }

  // ─── Размер по полю ────────────────────────────────────────────────────────

  /** `point.sizeBy` — если рендерер сам не задаёт размер (категории, правила, классы). */
  private withSizeBy(encoding: Encoding): Encoding {
    const sizeBy = this.style.point.sizeBy
    if (!sizeBy || this.s.geometry !== 'point' || encoding.size) return encoding
    if (this.style.renderer.kind === 'heatmap') return encoding
    const field = this.s.requireField(sizeBy.field, 'point.sizeBy.field')
    const scaled = this.scale(
      sizeBy.field,
      'point.sizeBy.field',
      sizeBy.min,
      sizeBy.max,
      sizeBy.scale,
    )
    const measure = this.s.measure(sizeBy.field, field?.format, scaled.samples)
    const color = sampleColor(encoding.color)
    return {
      ...encoding,
      size: scaled.plan,
      sizeField: sizeBy.field,
      sizes: {
        title: this.s.fieldLabel(sizeBy.field),
        items: this.sizeItems(color, scaled, measure, 'size-by'),
      },
    }
  }

  /**
   * Размер по значению: линейно, по квадратному корню (площадь кружка
   * пропорциональна значению) или по логарифму — между min и max диапазона поля.
   */
  private scale(
    key: string,
    path: string,
    min: number,
    max: number,
    scale: 'linear' | 'sqrt' | 'log',
  ): Scaled {
    const domain = this.s.ctx.domains?.[key]
    const middle = round2((min + max) / 2)
    if (!domain || !(domain.max > domain.min)) {
      if (!domain) this.s.warn('domain-missing', path, key)
      return { plan: constant(middle), samples: domain ? [domain.min] : [], sizeOf: () => middle }
    }
    const { min: d0, max: d1 } = domain
    let input: Expr
    let transform: (v: number) => number
    if (scale === 'sqrt' && d1 > 0) {
      input = expr('sqrt', expr('max', num(key), 0))
      transform = (v) => Math.sqrt(Math.max(v, 0))
    } else if (scale === 'log' && d0 > 0) {
      input = expr('ln', expr('max', num(key), d0))
      transform = (v) => Math.log(Math.max(v, d0))
    } else if (scale === 'log') {
      input = expr('ln', expr('+', expr('max', expr('-', num(key), d0), 0), 1))
      transform = (v) => Math.log(Math.max(v - d0, 0) + 1)
    } else {
      input = num(key)
      transform = (v) => v
    }
    const t0 = transform(d0)
    const t1 = transform(d1)
    if (!(t1 > t0)) return { plan: constant(middle), samples: [d0], sizeOf: () => middle }
    const sizeOf = (v: number) =>
      round2(min + ((Math.min(t1, Math.max(t0, transform(v))) - t0) / (t1 - t0)) * (max - min))
    // Середина — значение, чей размер посередине шкалы, округлённое до двух значащих цифр
    const inverse = (t: number): number => {
      if (scale === 'sqrt' && d1 > 0) return t * t
      if (scale === 'log' && d0 > 0) return Math.exp(t)
      if (scale === 'log') return Math.exp(t) - 1 + d0
      return t
    }
    const mid = Number(inverse((t0 + t1) / 2).toPrecision(2))
    const samples = [...new Set([d1, mid, d0])].filter((v) => v >= d0 && v <= d1)
    return {
      plan: {
        kind: 'interpolate',
        input,
        stops: [
          { at: round6(t0), value: min },
          { at: round6(t1), value: max },
        ],
        missing: { when: isNull(key), value: min },
      },
      samples,
      sizeOf,
    }
  }

  private sizeItems(
    color: string,
    scaled: Scaled,
    measure: (value: number) => string,
    prefix: string,
  ): LegendItem[] {
    const sizes = scaled.samples.map((v) => scaled.sizeOf(v))
    const maxSize = Math.max(...sizes, 0)
    return scaled.samples.map((value, i) => ({
      id: `${prefix}-${i + 1}`,
      label: measure(value),
      swatch:
        this.s.geometry === 'line'
          ? this.swatch(color, sizes[i] as number)
          : {
              kind: 'proportional-circle',
              color,
              outline: deriveOutline(color, this.s.theme),
              size: sizes[i] as number,
              maxSize,
              opacity: this.style.opacity,
            },
    }))
  }

  /** Постоянное изображение точек (квадрат, треугольник, значок стиля); кружок — null. */
  private pointImage(): Plan<string> | null {
    if (this.s.geometry !== 'point') return null
    const mark = this.mark()
    return mark.shape === 'circle' ? null : constant(this.imageOf(mark))
  }
}

interface Scaled {
  plan: Plan<number>
  /** Значения для легенды размера: максимум, середина, минимум диапазона. */
  samples: number[]
  sizeOf(value: number): number
}

type ValueKind = 'text' | 'number' | 'boolean'

interface Category {
  value: string | number | boolean | null
  index: number
  color: string
  size: number | null
  icon: string | null
  label: string
}

const NUMBER_TYPES = new Set([
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'rollup',
])

const round2 = (v: number) => Math.round(v * 100) / 100
const round6 = (v: number) => Number(v.toPrecision(6))

function normalizeValue(value: unknown, kind: ValueKind): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (kind === 'boolean') return value === true || value === 'true'
  if (kind === 'number') {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : String(value)
  }
  return String(value)
}

/** Цвет образца размера: основной цвет плана (первый из значений). */
function sampleColor(plan: Plan<string>): string {
  switch (plan.kind) {
    case 'constant':
      return plan.value
    case 'match':
    case 'case':
      return plan.cases[0]?.value ?? plan.fallback
    case 'step':
      return plan.stops.at(-1)?.value ?? plan.base
    case 'interpolate':
      return String(plan.stops[0]?.value ?? '')
  }
}

/**
 * Сопоставление значения поля с категориями: `match` по строке или целому числу,
 * `case` для «да/нет» и дробных чисел; пустое значение проверяется до `match`
 * (to-number пустого — 0).
 */
class CategoryMatcher {
  private readonly nullCategory: Category | undefined
  private readonly values: Category[]
  private readonly exact: boolean

  constructor(
    private readonly key: string,
    private readonly kind: ValueKind,
    categories: Category[],
  ) {
    this.nullCategory = categories.find((c) => c.value === null)
    this.values = categories.filter((c) => c.value !== null)
    this.exact =
      kind === 'text' ||
      (kind === 'number' &&
        this.values.every((c) => typeof c.value === 'number' && Number.isInteger(c.value)))
  }

  private input(): Expr {
    return this.kind === 'number' ? num(this.key) : str(this.key)
  }

  private equals(value: Category['value']): Expr {
    if (this.kind === 'boolean') return expr('==', get(this.key), value)
    if (typeof value === 'number')
      return expr('all', present(this.key), expr('==', num(this.key), value))
    return expr('==', str(this.key), String(value))
  }

  plan<T extends string | number>(pick: (category: Category) => T, fallback: T): Plan<T> {
    const missing = this.nullCategory
      ? { when: isNull(this.key), value: pick(this.nullCategory) }
      : this.kind === 'number'
        ? { when: isNull(this.key), value: fallback }
        : null
    if (this.values.length === 0) {
      return missing ? { kind: 'case', cases: [missing], fallback } : constant(fallback)
    }
    if (!this.exact || this.kind === 'boolean') {
      return {
        kind: 'case',
        cases: [
          ...(missing ? [missing] : []),
          ...this.values.map((c) => ({ when: this.equals(c.value), value: pick(c) })),
        ],
        fallback,
      }
    }
    return {
      kind: 'match',
      input: this.input(),
      cases: this.values.map((c) => ({ labels: [c.value as string | number], value: pick(c) })),
      fallback,
      missing,
    }
  }

  /** Объект попадает в какую-нибудь категорию («прочее» не рисуется). */
  anyCategory(): Condition {
    const parts: Condition[] = this.nullCategory ? [isNull(this.key)] : []
    if (this.values.length > 0) {
      if (this.exact && this.kind !== 'boolean') {
        const labels = this.values.map((c) => c.value as string | number)
        const test = expr('match', this.input(), labels, true, false)
        parts.push(this.kind === 'number' ? all([present(this.key), test]) : test)
      } else {
        parts.push(...this.values.map((c) => this.equals(c.value)))
      }
    }
    return any(parts)
  }
}

/** Подпись класса «от – до»; верхний класс из одного значения — одно число. */
function rangeLabel(
  state: StyleState,
  measure: (value: number) => string,
  from: number,
  to: number,
): string {
  if (from === to) return measure(from)
  return state.t('ui.map.legend.range', { from: measure(from), to: measure(to) })
}
