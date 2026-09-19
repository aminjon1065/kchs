import type { FieldFormat, LangText, LayerGeometry, LayerStyle, Locale } from '@kchs/contracts'
import { formatNumber, formatPercent, formatValue } from '@kchs/fields'
import { createTranslator, localizedText, type Translator } from '@kchs/i18n'
import type { Condition } from './expr.js'
import { CLUSTER_COUNT_FIELD } from './fields.js'
import { compileFilter, type Polarity } from './filter.js'
import { autoPrecision, trimmedPrecision } from './legend.js'
import type {
  MapImageRequest,
  MapStyleContext,
  MapTheme,
  StyleField,
  StyleWarning,
  StyleWarningCode,
} from './model.js'
import { deriveOutline, resolveColor } from './palette.js'

/** Шрифты подписей по умолчанию — стеки glyphs базовой карты (OpenMapTiles, Noto Sans). */
export const DEFAULT_FONTS = { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] } as const

/** Сторона изображений значков и фигур в логических пикселях: `icon-size` = диаметр / 32. */
export const MAP_IMAGE_SIZE = 32

const translators = new Map<Locale, Translator>()

function translator(locale: Locale): Translator {
  let t = translators.get(locale)
  if (!t) {
    t = createTranslator(locale)
    translators.set(locale, t)
  }
  return t
}

/**
 * Общее состояние компиляции одного стиля: тема, язык, поля, накопленные
 * замечания и изображения. Рендереры и слои читают его, а не контекст напрямую.
 */
export class StyleState {
  readonly theme: MapTheme
  readonly locale: Locale
  readonly t: Translator
  readonly geometry: LayerGeometry
  readonly warnings: StyleWarning[] = []
  private readonly images = new Map<string, MapImageRequest>()
  private readonly byKey: Map<string, StyleField>

  constructor(
    readonly style: LayerStyle,
    readonly ctx: MapStyleContext,
  ) {
    this.theme = ctx.theme
    this.locale = ctx.locale ?? 'ru'
    this.t = translator(this.locale)
    this.byKey = new Map(ctx.fields.map((field) => [field.key, field]))
    const data = ctx.geometry && ctx.geometry !== 'mixed' ? ctx.geometry : null
    if (data && data !== style.geometry) {
      this.warn('geometry-mismatch', 'geometry', `данные слоя — ${data}, стиль — ${style.geometry}`)
    }
    this.geometry = data ?? style.geometry
  }

  warn(code: StyleWarningCode, path: string, detail?: string): void {
    if (this.warnings.some((w) => w.code === code && w.path === path)) return
    this.warnings.push(detail === undefined ? { code, path } : { code, path, detail })
  }

  imageList(): MapImageRequest[] {
    return [...this.images.values()]
  }

  /** Изображение фигуры или значка (SDF): MapView регистрирует его до слоёв. */
  image(kind: 'shape' | 'icon', name: string): string {
    const id = `kchs-${kind}-${name}`
    if (!this.images.has(id)) this.images.set(id, { id, kind, name, sdf: true })
    return id
  }

  // ─── Поля ──────────────────────────────────────────────────────────────────

  field(key: string): StyleField | null {
    return this.byKey.get(key) ?? null
  }

  /** Поле, на которое ссылается стиль: нет в схеме — замечание, рисуем по имени. */
  requireField(key: string, path: string): StyleField | null {
    const field = this.field(key)
    if (!field && key !== CLUSTER_COUNT_FIELD && this.ctx.fields.length > 0) {
      this.warn('field-missing', path, key)
    }
    return field
  }

  fieldLabel(key: string): string {
    const label = this.field(key)?.label
    return label ? localizedText(label, this.locale) : key
  }

  text(value: LangText | null | undefined): string | null {
    return value ? localizedText(value, this.locale) || null : null
  }

  /** Значение поля для подписи легенды: варианты выбора, «да/нет», числа по формату. */
  formatValue(value: unknown, key: string): string {
    if (value === null || value === undefined) return this.t('ui.map.legend.none')
    const field = this.field(key)
    if (!field) return String(value)
    const out = formatValue(
      value,
      {
        type: field.type,
        format: field.format ?? undefined,
        options: field.options ? [...field.options] : undefined,
      },
      { locale: this.locale },
    )
    return out === '' ? this.t('ui.map.legend.none') : out
  }

  formatNumber(value: number, format: FieldFormat): string {
    return formatNumber(value, format, { locale: this.locale })
  }

  /**
   * Форматтер чисел легенды (границы классов, образцы размера): формат легенды или
   * поля, проценты — как проценты. Без точности в формате — подобранная по самим
   * значениям, и у каждого числа без лишних нулей: «2,4 – 18», а не «2,4 – 18,0».
   */
  measure(
    key: string | null,
    format: FieldFormat | null | undefined,
    values: readonly number[],
  ): (value: number) => string {
    const base = format ?? {}
    const ctx = { locale: this.locale }
    const percent = key !== null && this.field(key)?.type === 'percent'
    const scale = percent && base.scale !== 'percent' ? 100 : 1
    const auto = base.precision === undefined
    const precision = base.precision ?? autoPrecision(values.map((v) => v * scale))
    return (value) => {
      const digits = auto ? trimmedPrecision(value * scale, precision) : precision
      return percent
        ? formatPercent(value, { ...base, precision: digits }, ctx)
        : formatNumber(value, { ...base, precision: digits }, ctx)
    }
  }

  // ─── Цвета ─────────────────────────────────────────────────────────────────

  /** Цвет стиля → hex темы; неизвестный токен — первый цвет палитры с замечанием. */
  color(value: string, path: string): string {
    const resolved = resolveColor(value, this.theme)
    if (!resolved.known) this.warn('color-unknown', path, value)
    return resolved.color
  }

  /** Обводка: `auto` — производная от заливки, иначе — свой цвет. */
  outline(value: string, base: string, path: string): string {
    if (value === 'auto') return deriveOutline(base, this.theme)
    return this.color(value, path)
  }

  // ─── Условия ───────────────────────────────────────────────────────────────

  filter(node: Parameters<typeof compileFilter>[0], polarity: Polarity, path: string): Condition {
    return compileFilter(
      node,
      {
        fieldType: (key) => this.field(key)?.type ?? null,
        territoryDescendants: this.ctx.territoryDescendants,
        now: this.ctx.now,
        timezone: this.ctx.timezone ?? 'UTC',
        unsupported: (at, detail) => this.warn('filter-unsupported', at, detail),
      },
      polarity,
      path,
    )
  }
}
