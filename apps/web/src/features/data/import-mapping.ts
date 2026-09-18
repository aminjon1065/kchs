import {
  type DatasetField,
  type DatasetRecord,
  type FieldFormat,
  type FieldSemantic,
  IMPORT_FIELD_TYPES,
  type ImportAnalysis,
  type ImportFieldType,
  type ImportMode,
  type ImportOptions,
  type ImportRunInput,
} from '@kchs/contracts'

/**
 * Логика шага «Сопоставление» мастера импорта (03-screens.md §6) — без React:
 * строки сопоставления из анализа файла, проверка и сборка запроса запуска.
 */

/** Столбец файла → поле датасета. */
export interface MappingRow {
  column: number
  /** Заголовок столбца в файле. */
  name: string
  include: boolean
  fieldKey: string
  label: string
  type: ImportFieldType
  semantic: FieldSemantic
  format?: FieldFormat
  /** Ключевой столбец нового датасета. */
  key: boolean
}

export const FIELD_KEY = /^[a-z_][a-z0-9_]*$/
const THOUSANDS = new Set(['', ' ', ',', '.', "'"])
const IMPORT_TYPES = new Set<string>(IMPORT_FIELD_TYPES)

/** Настройки чтения, которые определил анализ, — чтобы нормализация читала файл так же. */
export function optionsFrom(analysis: ImportAnalysis): ImportOptions {
  return {
    format: analysis.format,
    ...(analysis.encoding ? { encoding: analysis.encoding } : {}),
    ...(analysis.delimiter ? { delimiter: analysis.delimiter } : {}),
    ...(analysis.sheet ? { sheet: analysis.sheet } : {}),
    skipRows: analysis.skipRows,
    headerRows: analysis.headerRows,
    ...(analysis.decimal ? { decimal: analysis.decimal } : {}),
    ...(analysis.thousands !== null && THOUSANDS.has(analysis.thousands)
      ? { thousands: analysis.thousands as NonNullable<ImportOptions['thousands']> }
      : {}),
    ...(analysis.dateOrder ? { dateOrder: analysis.dateOrder } : {}),
  }
}

const normalize = (value: string) => value.trim().toLowerCase()

/** Поле существующего датасета для столбца: по ключу, затем по подписи. */
function matchField(fields: DatasetField[], key: string, name: string): DatasetField | undefined {
  return (
    fields.find((field) => field.key === key) ??
    fields.find((field) =>
      Object.values(field.label).some((label) => label && normalize(label) === normalize(name)),
    )
  )
}

/** Поля датасета, в которые может писать импорт (без вычисляемых и служебных). */
export function importableFields(dataset: DatasetRecord): DatasetField[] {
  return dataset.fields.filter((field) => IMPORT_TYPES.has(field.type) && field.type !== 'geometry')
}

/** Строки сопоставления по анализу: для нового датасета — предложения движка. */
export function rowsFrom(analysis: ImportAnalysis, dataset?: DatasetRecord): MappingRow[] {
  const fields = dataset ? importableFields(dataset) : []
  const taken = new Set<string>()
  return analysis.columns.map((column) => {
    if (dataset) {
      const field = matchField(fields, column.key, column.name)
      const free = field && !taken.has(field.key)
      if (field && free) taken.add(field.key)
      return {
        column: column.index,
        name: column.name,
        include: Boolean(free),
        fieldKey: free ? field.key : '',
        label: free ? (field.label.ru ?? field.key) : column.name,
        type: free ? (field.type as ImportFieldType) : column.type,
        semantic: free ? field.semantic : column.semantic,
        ...(free && field.format ? { format: field.format } : {}),
        key: false,
      }
    }
    return {
      column: column.index,
      name: column.name,
      // Полностью пустой столбец по умолчанию не загружается
      include: column.emptyShare < 1,
      fieldKey: column.key,
      label: column.name.trim() || column.key,
      type: column.type,
      semantic: column.semantic,
      ...(column.format ? { format: column.format } : {}),
      key: false,
    }
  })
}

/** Имя нового датасета по умолчанию — имя файла без расширения. */
export function defaultDatasetName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || fileName
}

export type MappingProblem =
  | { code: 'none' }
  | { code: 'keyFormat' }
  | { code: 'duplicate'; key: string }
  | { code: 'name' }
  | { code: 'keyRequired' }
  | { code: 'unmapped'; column: string }

export interface MappingTarget {
  /** Существующий датасет или новый с именем `name`. */
  dataset?: DatasetRecord
  name: string
  mode: ImportMode
}

/** Что мешает запуску: пустое сопоставление, ключи полей, имя, ключ режима. */
export function mappingProblems(rows: MappingRow[], target: MappingTarget): MappingProblem[] {
  const problems: MappingProblem[] = []
  const included = rows.filter((row) => row.include)
  if (included.length === 0) problems.push({ code: 'none' })
  if (!target.dataset && !target.name.trim()) problems.push({ code: 'name' })

  const seen = new Set<string>()
  let badFormat = false
  for (const row of included) {
    if (target.dataset && !row.fieldKey) {
      problems.push({ code: 'unmapped', column: row.name })
      continue
    }
    if (!FIELD_KEY.test(row.fieldKey) || row.fieldKey.length > 64) badFormat = true
    if (seen.has(row.fieldKey)) problems.push({ code: 'duplicate', key: row.fieldKey })
    seen.add(row.fieldKey)
  }
  if (badFormat) problems.push({ code: 'keyFormat' })

  if (target.mode === 'upsert' || target.mode === 'sync') {
    const keyFields = target.dataset
      ? target.dataset.primaryKey
      : included.filter((row) => row.key).map((row) => row.fieldKey)
    if (keyFields.length === 0 || keyFields.some((key) => !seen.has(key))) {
      problems.push({ code: 'keyRequired' })
    }
  }
  return problems
}

/** Ключ поля геометрии, не совпадающий с полями сопоставления. */
export function geometryFieldKey(rows: MappingRow[]): string {
  const used = new Set(rows.filter((row) => row.include).map((row) => row.fieldKey))
  let key = 'geometry'
  for (let n = 2; used.has(key); n++) key = `geometry_${n}`
  return key
}

/** Запрос запуска импорта из состояния мастера. */
export function buildRunInput(input: {
  fileId: string
  options: ImportOptions
  rows: MappingRow[]
  target: MappingTarget & { spaceId: string }
  geometry: ImportAnalysis['geometry']
  onError: 'skip' | 'stop'
}): ImportRunInput {
  const included = input.rows.filter((row) => row.include)
  const { dataset } = input.target
  const mapping = included.map((row) => ({
    column: row.column,
    fieldKey: row.fieldKey,
    label: { ru: row.label.trim() || row.fieldKey },
    type: row.type,
    semantic: row.semantic,
    ...(row.format ? { format: row.format } : {}),
    required: false,
  }))
  const mapped = new Set(mapping.map((item) => item.fieldKey))
  const key = dataset
    ? dataset.primaryKey.every((field) => mapped.has(field))
      ? dataset.primaryKey
      : []
    : included.filter((row) => row.key).map((row) => row.fieldKey)
  // Новый датасет получает поле геометрии; существующий — если оно есть в схеме
  const geometryField = dataset
    ? dataset.fields.find((field) => field.type === 'geometry')?.key
    : geometryFieldKey(input.rows)
  const geometry = input.geometry && geometryField ? input.geometry : null
  return {
    fileId: input.fileId,
    options: input.options,
    target: dataset
      ? { kind: 'existing', datasetId: dataset.id, mode: input.target.mode }
      : { kind: 'new', name: input.target.name.trim(), spaceId: input.target.spaceId },
    mapping,
    ...(geometry && geometryField ? { geometry, geometryField } : {}),
    key,
    onError: input.onError,
  }
}
