import type { FieldType, QueryParam, QuerySource, QuerySpec, QueryStep } from '@kchs/contracts'
import type { CompileContext, CompiledQuery, ResolvedDataset, ResolvedField } from '../src/index.js'

export const IDS = {
  incidents: '11111111-1111-4111-8111-111111111111',
  regions: '22222222-2222-4222-8222-222222222222',
  archive: '33333333-3333-4333-8333-333333333333',
  staff: '44444444-4444-4444-8444-444444444444',
  savedTotals: '55555555-5555-4555-8555-555555555555',
  savedNested: '66666666-6666-4666-8666-666666666666',
  savedLoop: '77777777-7777-4777-8777-777777777777',
  savedArchiveAt: '88888888-8888-4888-8888-888888888888',
} as const

export const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const UNIT_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
export const UNIT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
export const TERR_DU = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
export const TERR_DU_1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
export const TERR_DU_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
export const TERR_KH = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4'
export const SUB_1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
export const SUB_2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'

/** Иерархия территорий: Душанбе → два района; Хатлон — без детей. */
export const TERRITORY_TREE: Record<string, string[]> = {
  [TERR_DU]: [TERR_DU_1, TERR_DU_2],
  [TERR_DU_1]: [],
  [TERR_DU_2]: [],
  [TERR_KH]: [],
}

export function descendants(id: string): string[] {
  return [id, ...(TERRITORY_TREE[id] ?? []).flatMap(descendants)]
}

type FieldSpec = [key: string, type: FieldType]

function fields(list: FieldSpec[]): ResolvedField[] {
  return list.map(([key, type], index) => ({
    key,
    type,
    physical: `c_${index + 1}`,
    label: { ru: key },
    semantic: null,
    format: null,
  }))
}

/** Поля датасета происшествий: все хранимые типы и одно вычисляемое. */
export const INCIDENT_FIELDS: FieldSpec[] = [
  ['title', 'text'],
  ['kind', 'select'],
  ['damage', 'money'],
  ['victims', 'integer'],
  ['occurred_at', 'datetime'],
  ['reported_on', 'date'],
  ['territory_id', 'territory'],
  ['assignee', 'user'],
  ['unit_id', 'unit'],
  ['tags', 'multi_select'],
  ['geom', 'geometry'],
  ['is_confirmed', 'boolean'],
  ['response', 'duration'],
  ['ratio', 'number'],
  ['phone', 'phone'],
  ['start_time', 'time'],
  ['meta', 'json'],
  ['score_formula', 'formula'],
  ['share', 'percent'],
  ['code', 'identifier'],
  ['email', 'email'],
  ['notes', 'long_text'],
]

export const REGION_FIELDS: FieldSpec[] = [
  ['territory_id', 'territory'],
  ['name', 'text'],
  ['population', 'integer'],
]

export const ARCHIVE_FIELDS: FieldSpec[] = [
  ['title', 'text'],
  ['kind', 'select'],
  ['damage', 'money'],
  ['occurred_at', 'datetime'],
  ['reported_on', 'date'],
]

export const STAFF_FIELDS: FieldSpec[] = [
  ['name', 'text'],
  ['salary', 'money'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['hired_on', 'date'],
  ['unit_id', 'unit'],
  ['passport', 'identifier'],
]

export function dataset(
  id: string,
  table: string,
  list: FieldSpec[],
  overrides: Partial<ResolvedDataset> = {},
): ResolvedDataset {
  return {
    id,
    table,
    fields: fields(list),
    rowPolicy: { kind: 'all' },
    columnPolicy: { hide: [], mask: [] },
    version: 7,
    ...overrides,
  }
}

export const incidents = dataset(IDS.incidents, 'ds.t_incidents', INCIDENT_FIELDS)
export const regions = dataset(IDS.regions, 'ds.t_regions', REGION_FIELDS, { version: 2 })
export const archive = dataset(IDS.archive, 'ds.t_archive', ARCHIVE_FIELDS, { version: 1 })
export const staff = dataset(IDS.staff, 'ds.t_staff', STAFF_FIELDS, { version: 3 })

export const NOW = new Date('2026-09-18T07:30:00Z')

export function ctx(overrides: Partial<CompileContext> = {}): CompileContext {
  return {
    datasets: new Map([
      [incidents.id, incidents],
      [regions.id, regions],
      [archive.id, archive],
      [staff.id, staff],
    ]),
    user: {
      id: USER_ID,
      unitIds: [UNIT_A, UNIT_B],
      territoryIds: [TERR_DU],
      subordinateIds: [SUB_1, SUB_2],
      attributes: { territory_codes: ['DU', 'KH'], level: 3, region: 'DU' },
      unitMemberIds: [USER_ID, SUB_1],
    },
    now: NOW,
    territoryDescendants: descendants,
    ...overrides,
  }
}

/** Контекст с другими датасетами (политики строк и столбцов). */
export function withDatasets(...list: ResolvedDataset[]): Partial<CompileContext> {
  const map = new Map(ctx().datasets)
  for (const item of list) map.set(item.id, item)
  return { datasets: map }
}

export function src(alias?: string): QuerySource {
  return { kind: 'dataset', id: IDS.incidents, ...(alias ? { alias } : {}) }
}

export function q(
  source: QuerySource,
  steps: QueryStep[] = [],
  params: Record<string, Partial<QueryParam> & { type: QueryParam['type'] }> = {},
  options: QuerySpec['options'] = { cache: true, approxCount: true },
): QuerySpec {
  const declared: Record<string, QueryParam> = {}
  for (const [name, param] of Object.entries(params)) {
    declared[name] = { required: false, ...param }
  }
  return { version: 1, source, steps, params: declared, options }
}

/** Эталонное представление результата компиляции для снимков. */
export function render(compiled: CompiledQuery): string {
  const fields = compiled.fields.map((field) => `${field.name}:${field.type}`).join(', ')
  return [
    compiled.sql,
    `-- params: ${JSON.stringify(compiled.params)}`,
    `-- fields: ${fields}`,
    `-- count: ${compiled.countSql.split('\n').at(-2) ?? ''} ${compiled.countSql.split('\n').at(-1) ?? ''}`,
  ].join('\n')
}
