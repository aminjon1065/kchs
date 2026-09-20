import type { PipelineStep, PipelineStepType } from '@kchs/contracts'

/**
 * Модель шага конструктора пайплайна (ADR-0106): чистые преобразования между
 * шагом и его «человеческим» видом в форме. Сложные шаги (соединение,
 * объединение, отбор, пространственное соединение) правятся как JSON — их
 * форма появится, когда конструктору понадобится выбор источников.
 */

/** Шаги, у которых в конструкторе есть своя форма. */
export const SIMPLE_STEPS = new Set<PipelineStepType>([
  'select',
  'rename',
  'cast',
  'dedupe',
  'fill',
  'split',
  'merge_columns',
  'compute',
  'unpivot',
  'geocode',
  'assign_territory',
  'custom_sql',
])

/** Новый шаг выбранного вида с разумными значениями. */
export function emptyStep(type: PipelineStepType, id: string): PipelineStep {
  const base = { id, disabled: false }
  switch (type) {
    case 'custom_sql':
      return { ...base, type, sql: 'SELECT 1' }
    case 'select':
      return { ...base, type, fields: [] }
    case 'rename':
      return { ...base, type, renames: [] }
    case 'cast':
      return { ...base, type, casts: [] }
    case 'filter':
      return { ...base, type, where: { and: [] } }
    case 'dedupe':
      return { ...base, type, by: [], keep: 'first', orderBy: [] }
    case 'fill':
      return { ...base, type, field: '', with: { kind: 'value', value: '' } }
    case 'split':
      return { ...base, type, field: '', separator: ',', into: [], drop: false }
    case 'merge_columns':
      return { ...base, type, fields: [], into: 'merged', separator: ' ', drop: false }
    case 'compute':
      return { ...base, type, fields: [] }
    case 'join':
      return { ...base, type, source: { kind: 'dataset', id: '' }, on: [], kind: 'left' }
    case 'union':
      return { ...base, type, source: { kind: 'dataset', id: '' }, mode: 'all' }
    case 'aggregate':
      return { ...base, type, groupBy: [], measures: [] }
    case 'unpivot':
      return {
        ...base,
        type,
        keep: [],
        fields: [],
        nameField: 'name',
        valueField: 'value',
        dropNulls: true,
      }
    case 'pivot':
      return { ...base, type, groupBy: [], column: '', values: [], measure: { agg: 'count' } }
    case 'geocode':
      return { ...base, type, field: '', match: 'code', as: 'territory_id' }
    case 'assign_territory':
      return { ...base, type, level: 'district' }
    case 'spatial_join':
      return { ...base, type, predicate: 'intersects', measures: [] }
  }
}

/** Список полей через запятую → массив без пустых значений. */
export const parseList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

/** Строки вида «слева → справа»: переименования, приведения, вычисления. */
export function parsePairs(value: string, separator: string): Array<[string, string]> {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(separator)
      return at < 0
        ? ([line, ''] as [string, string])
        : ([line.slice(0, at).trim(), line.slice(at + separator.length).trim()] as [string, string])
    })
    .filter(([left, right]) => left.length > 0 && right.length > 0)
}

export const formatPairs = (pairs: Array<[string, string]>, separator: string): string =>
  pairs.map(([left, right]) => `${left} ${separator} ${right}`).join('\n')

/** Короткое описание шага для списка конструктора. */
export function describeStep(step: PipelineStep): string {
  switch (step.type) {
    case 'custom_sql':
      return step.sql.slice(0, 80)
    case 'select':
      return step.fields.map((item) => item.as ?? item.field).join(', ')
    case 'rename':
      return step.renames.map((item) => `${item.field} → ${item.to}`).join(', ')
    case 'cast':
      return step.casts.map((item) => `${item.field}: ${item.to}`).join(', ')
    case 'dedupe':
      return step.by.join(', ')
    case 'fill':
      return step.field
    case 'split':
      return `${step.field} → ${step.into.join(', ')}`
    case 'merge_columns':
      return `${step.fields.join(', ')} → ${step.into}`
    case 'compute':
      return step.fields.map((item) => item.name).join(', ')
    case 'aggregate':
      return [...step.groupBy.map((item) => item.field), ...step.measures.map((m) => m.alias)].join(
        ', ',
      )
    case 'unpivot':
      return step.fields.join(', ')
    case 'pivot':
      return `${step.column}: ${step.values.join(', ')}`
    case 'geocode':
      return step.field
    case 'assign_territory':
      return step.level
    default:
      return ''
  }
}
