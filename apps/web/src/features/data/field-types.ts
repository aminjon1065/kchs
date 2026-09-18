import {
  type DatasetField,
  FIELD_SEMANTICS,
  type FieldOption,
  type FieldSemantic,
  type Locale,
  STORED_FIELD_TYPES,
  type StoredFieldType,
} from '@kchs/contracts'
import type { FilterField } from '@kchs/ui'

/** Семантики, которые выбирают вручную (справочник и служебная задаются иначе). */
export const PICKABLE_SEMANTICS = FIELD_SEMANTICS.filter(
  (value) => value !== 'system' && value !== 'lookup',
)

export const NUMERIC_TYPES = new Set<string>(['integer', 'number', 'decimal', 'money', 'percent'])

/** Типы нового поля — хранимые в таблице датасета. */
export const FIELD_TYPE_CHOICES: readonly StoredFieldType[] = STORED_FIELD_TYPES

/** Типы, к которым приводится поле (геометрия — нет, ADR-0047). */
export const CONVERTIBLE_TYPES = STORED_FIELD_TYPES.filter((type) => type !== 'geometry')

/** Поля, которые могут ссылаться на справочник: значение — ключ его строки. */
export const LOOKUP_TYPES = new Set<string>(['text', 'identifier', 'select', 'integer'])

/** Типы, которые не входят в ключ строки (как на сервере). */
export const NOT_KEY_TYPES = new Set<string>(['geometry', 'json', 'long_text', 'multi_select'])

/** Семантика по умолчанию для типа — как на сервере (`defaultSemantic`). */
export function defaultSemantic(type: string): FieldSemantic {
  if (NUMERIC_TYPES.has(type)) return 'measure'
  switch (type) {
    case 'date':
    case 'datetime':
      return 'time'
    case 'geometry':
      return 'geometry'
    case 'identifier':
      return 'identifier'
    case 'territory':
      return 'territory'
    case 'long_text':
      return 'text'
    default:
      return 'dimension'
  }
}

/** Подпись поля на языке интерфейса (запасные — русская подпись и ключ). */
export const fieldLabel = (field: DatasetField, locale: Locale): string =>
  field.label[locale] ?? field.label.ru ?? field.key

/** Поля датасета для конструктора фильтра: подписи и варианты выбора на языке интерфейса. */
export function filterFieldsOf(
  fields: readonly DatasetField[],
  locale: Locale,
  /** Справочные варианты полей (территории, справочники) — `useFieldOptions`. */
  choices: ReadonlyMap<string, readonly FieldOption[]> = new Map(),
): FilterField[] {
  return fields.map((field) => {
    const options = choices.get(field.key) ?? field.options
    return {
      key: field.key,
      label: fieldLabel(field, locale),
      type: field.type,
      ...(options
        ? {
            options: options.map((option) => ({
              value: option.value,
              label: option.label[locale] ?? option.label.ru,
            })),
          }
        : {}),
    }
  })
}
