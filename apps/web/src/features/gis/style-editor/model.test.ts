import { type DatasetField, LayerStyle } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { categoriesWithLabels, categoryValue, typedCategoryValue } from './categories.js'
import {
  appendTemplateField,
  base64urlJson,
  lineDashOf,
  parseBreaks,
  statsRequests,
  styleDirty,
  tilePreviewOf,
  warningsAt,
  withLangText,
  withRendererKind,
} from './model.js'

const field = (key: string, type: DatasetField['type'], extra: Partial<DatasetField> = {}) =>
  ({
    id: `00000000-0000-4000-8000-${key.padStart(12, '0').slice(-12)}`,
    key,
    label: { ru: key },
    type,
    semantic: 'dimension',
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: true,
    order: 0,
    ...extra,
  }) as DatasetField

const FIELDS: DatasetField[] = [
  field('name', 'text'),
  field('kind', 'select', {
    semantic: 'category',
    options: [
      { value: 'school', label: { ru: 'Школа' } },
      { value: 'hospital', label: { ru: 'Больница' } },
    ],
  }),
  field('district', 'territory', { semantic: 'territory' }),
  field('capacity', 'integer', { semantic: 'measure' }),
  field('area', 'number', { semantic: 'measure' }),
  field('opened', 'date', { semantic: 'time' }),
  field('place', 'geometry', { semantic: 'geometry' }),
]

const simple = LayerStyle.parse({
  version: 1,
  geometry: 'point',
  renderer: { kind: 'simple', color: 'categorical.1' },
  cluster: { enabled: true },
})

describe('форма стиля → LayerStyle', () => {
  it('смена вида рендерера: поле по смыслу, цвет переносится, результат проходит контракт', () => {
    const categorized = withRendererKind(simple, 'categorized', FIELDS)
    expect(categorized?.renderer).toEqual({
      kind: 'categorized',
      field: 'kind',
      categories: [
        { value: 'school', color: 'categorical.1' },
        { value: 'hospital', color: 'categorical.2' },
      ],
      other: { color: 'other' },
    })
    expect(LayerStyle.parse(categorized)).toEqual(categorized)

    const graduated = withRendererKind(simple, 'graduated', FIELDS)
    expect(graduated?.renderer).toMatchObject({ kind: 'graduated', field: 'capacity' })
    expect(LayerStyle.parse(graduated)).toEqual(graduated)

    // Кластеры и прочие части стиля не трогаются
    expect(graduated?.cluster).toEqual(simple.cluster)
    // Нет числовых полей — градуированный недоступен
    expect(withRendererKind(simple, 'graduated', [field('name', 'text')])).toBeNull()
    // Тот же вид — стиль как есть
    expect(withRendererKind(simple, 'simple', FIELDS)).toBe(simple)
  })

  it('статистика: границы градуированного с фильтром, диапазоны размера без повторов', () => {
    const style = LayerStyle.parse({
      version: 1,
      geometry: 'point',
      renderer: {
        kind: 'graduated',
        field: 'capacity',
        method: 'jenks',
        classes: 4,
        normalizeBy: 'area',
      },
      point: { sizeBy: { field: 'capacity' } },
      filter: { field: 'kind', op: 'eq', value: 'school' },
    })
    expect(statsRequests(style)).toEqual({
      breaks: {
        field: 'capacity',
        normalizeBy: 'area',
        method: 'jenks',
        classes: 4,
        filter: { field: 'kind', op: 'eq', value: 'school' },
      },
      domains: [
        {
          field: 'capacity',
          normalizeBy: null,
          method: null,
          classes: 5,
          filter: { field: 'kind', op: 'eq', value: 'school' },
        },
      ],
    })
    const manual = LayerStyle.parse({
      ...style,
      renderer: { ...style.renderer, method: 'manual', breaks: [0, 10, 100] },
      point: { ...style.point, sizeBy: null },
    })
    expect(statsRequests(manual)).toEqual({ breaks: null, domains: [] })
    const proportional = LayerStyle.parse({
      version: 1,
      geometry: 'point',
      renderer: { kind: 'proportional', field: 'area' },
      point: { sizeBy: { field: 'area' } },
    })
    expect(statsRequests(proportional).domains.map((request) => request.field)).toEqual(['area'])
  })

  it('предпросмотр тайлов — только когда рабочая копия меняет тайл', () => {
    expect(tilePreviewOf(simple, null)).toBeNull()
    // Цвет в тайле не нужен: тайлы сохранённого стиля годятся
    const recolored = { ...simple, renderer: { ...simple.renderer, color: 'danger' } }
    expect(tilePreviewOf(simple, recolored)).toBeNull()
    // Другой порядок ключей (стиль с сервера и из формы) — тот же стиль
    const reversed = (value: unknown): unknown =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .reverse()
              .map(([key, item]) => [key, reversed(item)]),
          )
        : value
    expect(tilePreviewOf(simple, reversed(simple) as LayerStyle)).toBeNull()

    const categorized = withRendererKind(simple, 'categorized', FIELDS) as LayerStyle
    expect(tilePreviewOf(simple, categorized)).toMatchObject({ fields: ['kind'], filter: null })
    const filtered = { ...simple, filter: { field: 'capacity', op: 'gt' as const, value: 10 } }
    expect(tilePreviewOf(simple, filtered)).toMatchObject({
      fields: [],
      filter: { field: 'capacity', op: 'gt', value: 10 },
    })
    const unclustered = { ...simple, cluster: null }
    expect(tilePreviewOf(simple, unclustered)).toMatchObject({ cluster: null })
    // Адрес тайла: base64url без «=», «+», «/»
    expect(base64urlJson({ a: 'ё?>>' })).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('рабочая копия «изменена», только если отличается по сути', () => {
    expect(styleDirty(simple, null)).toBe(false)
    expect(styleDirty(simple, LayerStyle.parse(JSON.parse(JSON.stringify(simple))))).toBe(false)
    expect(styleDirty(simple, { ...simple, opacity: 0.5 })).toBe(true)
  })

  it('ручные границы: «;» и пробелы, десятичная запятая, мусор отбрасывается', () => {
    expect(parseBreaks('0; 12,5;40 100')).toEqual([0, 12.5, 40, 100])
    expect(parseBreaks(' ; abc; 7 ')).toEqual([7])
  })

  it('подписи на языке интерфейса: русский обязателен, пустой — без подписи', () => {
    expect(withLangText(null, 'ru', 'Школы')).toEqual({ ru: 'Школы' })
    expect(withLangText({ ru: 'Школы' }, 'en', 'Schools')).toEqual({ ru: 'Школы', en: 'Schools' })
    expect(withLangText(null, 'en', 'Schools')).toEqual({ ru: 'Schools', en: 'Schools' })
    expect(withLangText({ ru: 'Школы', en: 'Schools' }, 'en', '')).toEqual({ ru: 'Школы' })
    expect(withLangText({ ru: 'Школы' }, 'ru', '  ')).toBeNull()
    // Пробел в конце набираемого текста сохраняется
    expect(withLangText(null, 'ru', 'Высокий ')).toEqual({ ru: 'Высокий ' })
  })

  it('штрихи, шаблоны и замечания у полей формы', () => {
    expect(lineDashOf(null)).toBe('solid')
    expect(lineDashOf([4, 2])).toBe('dash')
    expect(lineDashOf([3, 3])).toBe('custom')
    expect(appendTemplateField('', 'name')).toBe('{{name}}')
    expect(appendTemplateField('{{name}}', 'kind')).toBe('{{name}} {{kind}}')
    const warnings = [
      { code: 'field-missing' as const, path: 'renderer.field', detail: 'x' },
      { code: 'color-unknown' as const, path: 'renderer.categories.1.color', detail: 'y' },
      { code: 'breaks-missing' as const, path: 'renderer' },
    ]
    expect(warningsAt(warnings, 'renderer.categories.1').map((w) => w.code)).toEqual([
      'color-unknown',
    ])
    expect(warningsAt(warnings, 'renderer', { exact: true }).map((w) => w.code)).toEqual([
      'breaks-missing',
    ])
  })
})

describe('значения категорий', () => {
  it('значение из ответа и введённое вручную — в типе поля', () => {
    expect(categoryValue(undefined)).toBeNull()
    expect(categoryValue(3)).toBe(3)
    expect(categoryValue({ a: 1 })).toBe('[object Object]')
    expect(typedCategoryValue(' 12,5 ', field('v', 'number'))).toBe(12.5)
    expect(typedCategoryValue('да', field('v', 'boolean'))).toBe(true)
    expect(typedCategoryValue('нет', field('v', 'boolean'))).toBe(false)
    expect(typedCategoryValue('', field('v', 'text'))).toBeNull()
    expect(typedCategoryValue('school', field('v', 'text'))).toBe('school')
  })

  it('подписи — у территорий и справочников; у выбора легенда подписывает сама', () => {
    const territories = [{ value: 'id-kt', label: { ru: 'Хатлон', en: 'Khatlon' } }]
    expect(categoriesWithLabels(['id-kt', 'id-x'], FIELDS[2], territories)).toEqual([
      { value: 'id-kt', color: 'categorical.1', label: { ru: 'Хатлон', en: 'Khatlon' } },
      { value: 'id-x', color: 'categorical.2' },
    ])
    expect(categoriesWithLabels(['school'], FIELDS[1], FIELDS[1]?.options)).toEqual([
      { value: 'school', color: 'categorical.1' },
    ])
  })
})
