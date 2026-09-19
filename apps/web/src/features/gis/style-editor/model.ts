import {
  type ClassificationMethod,
  type FilterNode,
  type LangText,
  type LayerStyle,
  type LayerTilePreview,
  type Locale,
  layerTilePreview,
  type StyleRenderer,
} from '@kchs/contracts'
import { defaultRenderer, type PresetField, type StyleWarning } from '@kchs/map-style'

/**
 * Модель редактора стиля слоя (P2-E01 S03, ADR-0075): рабочая копия — сам
 * `LayerStyle`; здесь — что из неё следует для карты (предпросмотр тайлов,
 * статистика классов) и правки, общие для всех разделов формы.
 */

export type RendererKind = StyleRenderer['kind']

export const RENDERER_KINDS: readonly RendererKind[] = [
  'simple',
  'categorized',
  'graduated',
  'proportional',
  'heatmap',
  'rule',
]

/** Запрос статистики поля слоя (`POST /gis/layers/{id}/stats`). */
export interface StatsRequest {
  field: string
  normalizeBy: string | null
  method: Exclude<ClassificationMethod, 'manual'> | null
  classes: number
  /** Фильтр рабочей копии: статистика — по тем же строкам, что на карте. */
  filter: FilterNode | null
}

/**
 * Статистика, нужная стилю: границы градуированного стиля (кроме ручных) и
 * диапазоны полей размера по значению, веса тепловой карты и `point.sizeBy`.
 */
export function statsRequests(style: LayerStyle): {
  breaks: StatsRequest | null
  domains: StatsRequest[]
} {
  const renderer = style.renderer
  const filter = style.filter
  const domain = (field: string): StatsRequest => ({
    field,
    normalizeBy: null,
    method: null,
    classes: 5,
    filter,
  })
  const domains = new Map<string, StatsRequest>()
  let breaks: StatsRequest | null = null
  if (renderer.kind === 'graduated' && renderer.method !== 'manual') {
    breaks = {
      field: renderer.field,
      normalizeBy: renderer.normalizeBy,
      method: renderer.method,
      classes: renderer.classes,
      filter,
    }
  }
  if (renderer.kind === 'proportional') domains.set(renderer.field, domain(renderer.field))
  if (renderer.kind === 'heatmap' && renderer.weightField) {
    domains.set(renderer.weightField, domain(renderer.weightField))
  }
  if (style.geometry === 'point' && style.point.sizeBy) {
    domains.set(style.point.sizeBy.field, domain(style.point.sizeBy.field))
  }
  return { breaks, domains: [...domains.values()] }
}

/** Канонический JSON: ключи объектов по алфавиту — сравнение стилей без учёта порядка. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  )
}

export const sameStyle = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/** Рабочая копия отличается от сохранённого стиля. */
export function styleDirty(saved: LayerStyle, draft: LayerStyle | null | undefined): boolean {
  return draft !== null && draft !== undefined && !sameStyle(saved, draft)
}

/**
 * Предпросмотр тайлов рабочей копии: поля, фильтр, кластеры, масштабы и время
 * отличаются от сохранённых — тайлы с `p`; иначе годятся тайлы сохранённого стиля.
 */
export function tilePreviewOf(
  saved: LayerStyle,
  draft: LayerStyle | null | undefined,
): LayerTilePreview | null {
  if (!draft) return null
  const next = layerTilePreview(draft)
  return sameStyle(next, layerTilePreview(saved)) ? null : next
}

/** JSON в base64url — формат параметров `f` и `p` адреса тайлов. */
export function base64urlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Новый вид рендерера: поле и цвет переносятся, если подходят; нет подходящего
 * поля — null (вид недоступен). Размер кластеров и подписи не трогаются.
 */
export function withRendererKind(
  style: LayerStyle,
  kind: RendererKind,
  fields: readonly PresetField[],
): LayerStyle | null {
  if (style.renderer.kind === kind) return style
  const renderer = defaultRenderer(kind, {
    fields,
    geometry: style.geometry,
    previous: style.renderer,
  })
  return renderer ? { ...style, renderer } : null
}

/** Замечания компилятора у поля формы: путь совпадает или вложен в него. */
export function warningsAt(
  warnings: readonly StyleWarning[],
  path: string,
  options: { exact?: boolean } = {},
): StyleWarning[] {
  return warnings.filter(
    (warning) => warning.path === path || (!options.exact && warning.path.startsWith(`${path}.`)),
  )
}

/** Штрихи линии: сплошная, штрих, пунктир, штрих-пунктир — в ширинах линии. */
export const LINE_DASHES = {
  solid: null,
  dash: [4, 2],
  dot: [1, 2],
  dashdot: [4, 2, 1, 2],
} as const
export type LineDash = keyof typeof LINE_DASHES

export function lineDashOf(dash: readonly number[] | null): LineDash | 'custom' {
  if (!dash || dash.every((d) => d === 0)) return 'solid'
  for (const [name, value] of Object.entries(LINE_DASHES)) {
    if (value && value.length === dash.length && value.every((d, i) => d === dash[i])) {
      return name as LineDash
    }
  }
  return 'custom'
}

/**
 * Ручные границы из строки: числа через «;» или пробел, десятичный знак —
 * точка или запятая (русская запись «12,5»). Нечисла отбрасываются.
 */
export function parseBreaks(text: string): number[] {
  return text
    .split(/[;\s]+/)
    .map((part) => part.trim().replace(',', '.'))
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite)
}

/** Поля шаблона `{{поле}}` — вставка поля в конец шаблона с пробелом. */
export function appendTemplateField(template: string, key: string): string {
  const token = `{{${key}}}`
  if (!template.trim()) return token
  return /\s$/.test(template) ? `${template}${token}` : `${template} ${token}`
}

/**
 * Текст на языке интерфейса в `LangText`: русский обязателен — без него берётся
 * тот же текст; пустой текст убирает перевод, пустой русский — всю подпись.
 */
export function withLangText(
  current: LangText | null | undefined,
  locale: Locale,
  text: string,
): LangText | null {
  // Пробелы не обрезаются: поле ввода управляемое, пробел между словами нужен
  const next: Record<string, string> = { ...(current ?? {}), [locale]: text }
  if (!next.ru?.trim()) next.ru = text
  const cleaned = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value.trim() !== ''),
  )
  return cleaned.ru ? (cleaned as LangText) : null
}
