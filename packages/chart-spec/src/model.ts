import type {
  Channel,
  ChartSpec,
  LangText,
  Locale,
  QueryResult,
  QueryResultField,
} from '@kchs/contracts'
import type { FormatContext } from '@kchs/fields'
import { createTranslator, localizedText, type Translator } from '@kchs/i18n'
import type { EChartsOption } from 'echarts'
import type { ChartColorToken, ChartTheme } from './theme.js'

/** Параметры компиляции, которых нет в спецификации: язык, пояс, домен цветов. */
export interface CompileOptions {
  locale?: Locale
  /** Пояс платформы для моментов времени; даты без времени не сдвигаются. */
  timezone?: string
  /**
   * Полный упорядоченный домен значений поля цвета (например, все районы
   * справочника). Цвет закрепляется за сущностью: фильтр, убравший часть
   * серий, не перекрашивает оставшиеся. Без домена — порядок появления.
   */
  colorDomain?: readonly string[]
  /** Что считается улучшением для дельт показателя. */
  direction?: 'higher_better' | 'lower_better'
  /** Предел точек серии; выше — LTTB для линий, top-N для категорий. */
  maxPoints?: number
  animation?: boolean
  /** Текстуры заливок — печать, цветослепота, forced-colors. */
  decal?: boolean
}

/** Условие фильтра из клика или выделения на графике. */
export interface ChartFilter {
  field: string
  op: 'eq' | 'in' | 'not_in' | 'between'
  value: unknown
}

/** Элемент графика под курсором: подпись и условия, которые его выбирают. */
export interface ChartPick {
  label: string
  filters: ChartFilter[]
}

/** Параметры события ECharts, которых достаточно для сопоставления со строками. */
export interface PickParams {
  seriesIndex?: number
  dataIndex?: number
  /** Элемент данных серии (узел древовидной карты). */
  data?: unknown
}

/** Выделение кистью: индексы данных по сериям (событие brushSelected). */
export interface BrushSelection {
  seriesIndex: number
  dataIndex: number[]
}

export interface ChartTableColumn {
  key: string
  label: string
  numeric: boolean
}

/** Таблица данных графика: то, что нарисовано, уже отформатированное. */
export interface ChartTableModel {
  caption: string
  columns: ChartTableColumn[]
  rows: string[][]
  /** Строк всего (до обрезки). */
  total: number
}

export interface ChartMeta {
  /** Замечания для подписи под графиком: скрытые серии, даунсэмплинг. */
  notes: string[]
}

export interface NumberTileModel {
  label: string
  value: number | null
  formatted: string
  unit: string | null
  delta: {
    value: number
    formatted: string
    /** Направление изменения. */
    direction: 'up' | 'down' | 'flat'
    /** Хорошо ли это с учётом `direction` показателя; null — нейтрально. */
    good: boolean | null
    label: string
  } | null
  target: { value: number; formatted: string; progress: number; label: string } | null
  /** Цвет порога, в который попало значение. */
  status: ChartColorToken | null
  spark: number[]
}

export interface ChartIssue {
  path: (string | number)[]
  message: string
}

export type CompiledChart =
  | {
      kind: 'echarts'
      option: EChartsOption
      table: ChartTableModel
      alt: string
      meta: ChartMeta
      pick: (params: PickParams) => ChartPick | null
      brush: (selection: readonly BrushSelection[]) => ChartFilter | null
    }
  | { kind: 'number'; model: NumberTileModel; table: ChartTableModel; alt: string; meta: ChartMeta }
  | { kind: 'table'; table: ChartTableModel; alt: string; meta: ChartMeta }
  | { kind: 'empty'; alt: string; message: string }
  | { kind: 'unsupported'; alt: string; message: string; table: ChartTableModel | null }
  | { kind: 'invalid'; alt: string; message: string; issues: ChartIssue[] }

// ─── Контекст компиляции ─────────────────────────────────────────────────────

export interface FieldRef {
  index: number
  def: QueryResultField
}

export interface Ctx {
  spec: ChartSpec
  result: QueryResult
  theme: ChartTheme
  locale: Locale
  fmt: FormatContext
  t: Translator
  maxPoints: number
  animation: boolean
  decal: boolean
  colorDomain: readonly string[] | null
  direction: 'higher_better' | 'lower_better'
  notes: string[]
  field(name: string | undefined | null): FieldRef | null
  /** Подпись канала: своя → поля результата → имя поля. */
  label(channel: Pick<Channel, 'field' | 'label'> | null | undefined): string
  column(ref: FieldRef): unknown[]
}

const translators = new Map<Locale, Translator>()

export function chartT(locale: Locale): Translator {
  let t = translators.get(locale)
  if (!t) {
    t = createTranslator(locale)
    translators.set(locale, t)
  }
  return t
}

export function langText(text: LangText | null | undefined, locale: Locale): string | null {
  return text ? localizedText(text, locale) : null
}

export function createCtx(
  spec: ChartSpec,
  result: QueryResult,
  theme: ChartTheme,
  options: CompileOptions,
): Ctx {
  const locale = options.locale ?? 'ru'
  const index = new Map(result.fields.map((f, i) => [f.name, i]))
  const ctx: Ctx = {
    spec,
    result,
    theme,
    locale,
    fmt: { locale, timezone: options.timezone },
    t: chartT(locale),
    maxPoints: options.maxPoints ?? 5000,
    animation: options.animation ?? true,
    decal: options.decal ?? false,
    colorDomain: options.colorDomain ?? null,
    direction: options.direction ?? 'higher_better',
    notes: [],
    field(name) {
      if (!name) return null
      const i = index.get(name)
      return i === undefined ? null : { index: i, def: result.fields[i] as QueryResultField }
    },
    label(channel) {
      if (!channel) return ''
      const own = langText(channel.label, locale)
      if (own) return own
      const ref = ctx.field(channel.field)
      return langText(ref?.def.label, locale) ?? channel.field
    },
    column(ref) {
      return result.rows.map((row) => row[ref.index])
    },
  }
  return ctx
}
