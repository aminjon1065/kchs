import type {
  FieldSemantic,
  FieldType,
  LayerGeometry,
  LayerStyle,
  StyleRenderer,
} from '@kchs/contracts'

/**
 * «Умные» пресеты стиля по семантике полей датасета (07-gis-engine.md §4,
 * ADR-0075) и стиль рендерера по умолчанию — общие для редактора стиля, диалога
 * «Добавить слой» и мастеров, создающих слои.
 */

/** Поле датасета для пресетов: тип, семантика, варианты выбора (FieldDef подходит как есть). */
export interface PresetField {
  key: string
  type: FieldType
  semantic?: FieldSemantic | null
  options?: ReadonlyArray<{ value: string }> | null
}

export type StylePresetKind =
  | 'simple'
  | 'categorized'
  | 'graduated'
  | 'proportional'
  | 'heatmap'
  | 'time'

export interface StylePreset {
  /** Стабильный ключ: `simple`, `categorized:kind`, `time:occurred_at`. */
  id: string
  kind: StylePresetKind
  /** Поле, по которому строится стиль; у простого и тепловой без веса — null. */
  field: string | null
}

/** Значение категории: строка, число, «да/нет» или пустое. */
export type CategoryValue = string | number | boolean | null

/** Роль поля в стиле: категории, числа (классы, размер, вес), время, подпись. */
export type FieldRole = 'category' | 'number' | 'time' | 'label'

const NUMERIC_TYPES = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
const TEMPORAL_TYPES = new Set<FieldType>(['date', 'datetime'])
/** Значения, которые сравниваются с категориями в тайле как есть: текст, выбор, коды, целые. */
const CATEGORY_TYPES = new Set<FieldType>([
  'text',
  'select',
  'boolean',
  'integer',
  'identifier',
  'territory',
  'unit',
  'user',
  'url',
  'email',
  'phone',
])
/** В подпись не годятся: геометрия, структуры, файлы. */
const NOT_LABEL_TYPES = new Set<FieldType>(['geometry', 'json', 'file', 'signature'])

/** Цветов категориальной палитры — остальные значения идут в «прочее» (ADR-0049). */
export const CATEGORY_COLORS = 8
/** Пресетов одного вида: длинный список полей не превращает выбор в простыню. */
const PRESETS_PER_KIND = 6

/** Подходит ли поле для роли в стиле. */
export function fieldFits(field: PresetField, role: FieldRole): boolean {
  if (field.semantic === 'system' || field.type === 'geometry') return false
  switch (role) {
    case 'category':
      return CATEGORY_TYPES.has(field.type)
    case 'number':
      return NUMERIC_TYPES.has(field.type)
    case 'time':
      return TEMPORAL_TYPES.has(field.type)
    case 'label':
      return !NOT_LABEL_TYPES.has(field.type)
  }
}

/** Поля для роли — в порядке схемы. */
export function fieldsFor<T extends PresetField>(fields: readonly T[], role: FieldRole): T[] {
  return fields.filter((field) => fieldFits(field, role))
}

/** Категория по смыслу: семантика «категория», варианты выбора, «да/нет». */
function isCategory(field: PresetField): boolean {
  if (!fieldFits(field, 'category')) return false
  return field.semantic === 'category' || field.type === 'select' || field.type === 'boolean'
}

/** Мера: числовое поле с семантикой «мера» (у полей без семантики — любое число). */
function isMeasure(field: PresetField): boolean {
  if (!fieldFits(field, 'number')) return false
  return field.semantic === 'measure' || field.semantic === undefined || field.semantic === null
}

function isTime(field: PresetField): boolean {
  if (!fieldFits(field, 'time')) return false
  return field.semantic === 'time' || field.semantic === undefined || field.semantic === null
}

/**
 * Пресеты по семантике полей: простой — всегда; категория → «по категориям»;
 * мера → градуированный (у точек ещё и размер по значению); у точек — тепловая
 * карта; время → время на карте поверх текущего рендерера.
 */
export function stylePresets(
  fields: readonly PresetField[],
  geometry: LayerGeometry,
): StylePreset[] {
  const presets: StylePreset[] = [{ id: 'simple', kind: 'simple', field: null }]
  const take = (list: PresetField[]) => list.slice(0, PRESETS_PER_KIND)
  for (const field of take(fields.filter(isCategory))) {
    presets.push({ id: `categorized:${field.key}`, kind: 'categorized', field: field.key })
  }
  const measures = take(fields.filter(isMeasure))
  for (const field of measures) {
    presets.push({ id: `graduated:${field.key}`, kind: 'graduated', field: field.key })
  }
  if (geometry === 'point') {
    for (const field of measures) {
      presets.push({ id: `proportional:${field.key}`, kind: 'proportional', field: field.key })
    }
    presets.push({ id: 'heatmap', kind: 'heatmap', field: null })
  }
  for (const field of take(fields.filter(isTime))) {
    presets.push({ id: `time:${field.key}`, kind: 'time', field: field.key })
  }
  return presets
}

/**
 * Категории по значениям поля (самые частые — первыми): цвета палитры графиков
 * по порядку, пустое значение — нейтральным. Больше восьми — в «прочее».
 */
export function categoriesFor(
  values: readonly CategoryValue[],
  limit = CATEGORY_COLORS,
): Array<{ value: CategoryValue; color: string }> {
  const seen = new Set<string>()
  const out: Array<{ value: CategoryValue; color: string }> = []
  let colored = 0
  for (const value of values) {
    const signature = JSON.stringify(value)
    if (seen.has(signature)) continue
    seen.add(signature)
    if (out.length >= limit) break
    if (value === null) {
      out.push({ value, color: 'neutral' })
      continue
    }
    out.push({ value, color: `categorical.${(colored % CATEGORY_COLORS) + 1}` })
    colored += 1
  }
  return out
}

/** Цвет простого стиля или размера по значению — переносится при смене рендерера. */
function mainColor(renderer: StyleRenderer | null | undefined): string | null {
  if (renderer?.kind === 'simple' || renderer?.kind === 'proportional') return renderer.color
  return null
}

/** Поле рендерера, если оно подходит для роли. */
function carriedField(
  renderer: StyleRenderer | null | undefined,
  fields: readonly PresetField[],
  role: FieldRole,
): string | null {
  if (!renderer) return null
  const key =
    renderer.kind === 'heatmap'
      ? renderer.weightField
      : 'field' in renderer
        ? (renderer.field as string)
        : null
  const field = key ? fields.find((item) => item.key === key) : undefined
  return field && fieldFits(field, role) ? field.key : null
}

/**
 * Первое поле для роли — сначала по смыслу (категория, мера, время), затем любое
 * подходящее, кроме идентификаторов: код объекта — плохая категория.
 */
function preferredField(fields: readonly PresetField[], role: FieldRole): string | null {
  const fitting = fieldsFor(fields, role)
  const bySense =
    role === 'category'
      ? fitting.find(isCategory)
      : role === 'number'
        ? fitting.find(isMeasure)
        : role === 'time'
          ? fitting.find(isTime)
          : undefined
  const plain = fitting.find((field) => field.semantic !== 'identifier')
  return (bySense ?? plain ?? fitting[0])?.key ?? null
}

export interface RendererOptions {
  fields: readonly PresetField[]
  geometry: LayerGeometry
  /** Поле рендерера; без него — поле текущего рендерера или первое подходящее. */
  field?: string | null
  /** Текущий рендерер: цвет и подходящее поле переносятся в новый. */
  previous?: StyleRenderer | null
  /** Значения категорий (самые частые — первыми) для «по категориям». */
  categories?: readonly CategoryValue[] | null
}

/**
 * Рендерер вида `kind` с разумными значениями: поле — заданное, текущее или
 * первое подходящее; категории — из значений или вариантов выбора поля.
 * Нет подходящего поля (градуированный без чисел) — null: вид недоступен.
 */
export function defaultRenderer(
  kind: StyleRenderer['kind'],
  options: RendererOptions,
): StyleRenderer | null {
  const { fields, previous } = options
  const pick = (role: FieldRole): string | null => {
    const wanted = options.field ? fields.find((field) => field.key === options.field) : undefined
    if (wanted && fieldFits(wanted, role)) return wanted.key
    return carriedField(previous, fields, role) ?? preferredField(fields, role)
  }
  const color = mainColor(previous) ?? 'categorical.1'
  switch (kind) {
    case 'simple':
      return {
        kind: 'simple',
        color,
        icon: previous?.kind === 'simple' ? previous.icon : null,
      }
    case 'categorized': {
      const field = pick('category')
      if (!field) return null
      const def = fields.find((item) => item.key === field)
      const values: readonly CategoryValue[] =
        options.categories ?? (def?.options ?? []).map((option) => option.value)
      return {
        kind: 'categorized',
        field,
        categories: categoriesFor(values),
        other: { color: 'other' },
      }
    }
    case 'graduated': {
      const field = pick('number')
      if (!field) return null
      return {
        kind: 'graduated',
        field,
        method: 'quantile',
        classes: 5,
        breaks: null,
        palette: { name: 'blue', reverse: false },
        normalizeBy: null,
        visual: { target: 'fill' },
      }
    }
    case 'heatmap': {
      if (options.geometry !== 'point') return null
      const wanted = options.field ? pick('number') : null
      return {
        kind: 'heatmap',
        weightField: wanted,
        radius: 20,
        intensity: 1,
        palette: { name: 'orange', reverse: false },
      }
    }
    case 'proportional': {
      if (options.geometry === 'polygon') return null
      const field = pick('number')
      if (!field) return null
      return { kind: 'proportional', field, min: 4, max: 24, scale: 'sqrt', color }
    }
    case 'rule': {
      const field = fieldsFor(fields, 'label')[0]?.key
      if (!field) return null
      return {
        kind: 'rule',
        rules: [{ filter: { field, op: 'not_empty' }, color }],
        other: { color: 'other' },
      }
    }
  }
}

/**
 * Стиль по пресету: рендерер нужного вида по полю пресета, остальное — как было.
 * «Время» меняет только время на карте. Пресет без подходящего поля — стиль как есть.
 */
export function applyStylePreset(
  style: LayerStyle,
  preset: StylePreset,
  options: { fields: readonly PresetField[]; categories?: readonly CategoryValue[] | null },
): LayerStyle {
  if (preset.kind === 'time') {
    if (!preset.field) return style
    return {
      ...style,
      time: { field: preset.field, mode: style.time?.mode ?? 'range', step: 'day' },
    }
  }
  const renderer = defaultRenderer(preset.kind, {
    fields: options.fields,
    geometry: style.geometry,
    field: preset.field,
    previous: style.renderer,
    categories: options.categories ?? null,
  })
  return renderer ? { ...style, renderer } : style
}
