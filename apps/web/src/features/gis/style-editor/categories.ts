import type { DatasetField, FieldOption, FilterNode, LangText, QueryResult } from '@kchs/contracts'
import { type CategoryValue, categoriesFor } from '@kchs/map-style'
import { http } from '~/shared/api/client.js'

/** Значений поля для категорий: самые частые — первыми, остальное добавляют вручную. */
const CATEGORY_VALUES = 100
/** «Да» на языках интерфейса — разбор ввода, а не текст интерфейса. */
const YES = new Set(['true', '1', 'yes', 'да', 'ҳа']) // i18n-ignore

/**
 * Значения поля по частоте — запрос через компилятор с политиками смотрящего
 * (`/queries/run`): читатель с политикой строк получает только свои значения.
 * Фильтр — рабочей копии стиля, как у строк на карте.
 */
export async function loadCategoryValues(
  datasetId: string,
  field: string,
  filter: FilterNode | null,
): Promise<CategoryValue[]> {
  const result = await http.post<QueryResult>('/queries/run', {
    spec: {
      version: 1,
      source: { kind: 'dataset', id: datasetId },
      steps: [
        ...(filter ? [{ type: 'filter', where: filter }] : []),
        {
          type: 'aggregate',
          groupBy: [{ field, alias: 'category' }],
          measures: [{ alias: 'rows', agg: 'count' }],
        },
        {
          type: 'sort',
          by: [
            { field: 'rows', dir: 'desc' },
            { field: 'category', dir: 'asc' },
          ],
        },
        { type: 'limit', limit: CATEGORY_VALUES },
      ],
    },
  })
  const index = result.fields.findIndex((column) => column.name === 'category')
  return result.rows.map((row) => categoryValue(row[index]))
}

/** Значение из ответа как значение категории: строка, число, «да/нет» или пусто. */
export function categoryValue(value: unknown): CategoryValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return String(value)
}

/**
 * Значение, введённое вручную, — в типе поля: числа числами, «да/нет» —
 * логическим; пустая строка — пустое значение.
 */
export function typedCategoryValue(text: string, field: DatasetField | undefined): CategoryValue {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (field?.type === 'boolean') return YES.has(trimmed.toLowerCase())
  if (field && ['integer', 'number', 'decimal', 'money', 'percent'].includes(field.type)) {
    const number = Number(trimmed.replace(',', '.'))
    return Number.isFinite(number) ? number : trimmed
  }
  return trimmed
}

/**
 * Категории по значениям: цвета палитры по порядку; у справочников и
 * территорий — подписи из вариантов (в легенде — название, а не ключ).
 */
export function categoriesWithLabels(
  values: readonly CategoryValue[],
  field: DatasetField | undefined,
  options: readonly FieldOption[] | undefined,
): Array<{ value: CategoryValue; color: string; label?: LangText }> {
  // Варианты выбора самого поля легенда подписывает сама
  const needLabels = field ? field.type !== 'select' && Boolean(options?.length) : false
  return categoriesFor(values).map((category) => {
    const option =
      needLabels && category.value !== null
        ? options?.find((item) => item.value === String(category.value))
        : undefined
    return option ? { ...category, label: option.label } : category
  })
}
