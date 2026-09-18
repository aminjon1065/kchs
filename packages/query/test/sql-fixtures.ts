import type { CompiledRawSql, RawSqlContext, ResolvedDataset, SqlDataset } from '../src/index.js'
import { archive, ctx, incidents, regions, staff } from './fixtures.js'

/** Подписи полей тестовых датасетов: ru — основная, у нескольких полей — tg и en. */
const LABELS: Record<string, Record<string, string>> = {
  incidents: {
    title: 'Название',
    kind: 'Вид',
    damage: 'Ущерб',
    victims: 'Пострадавшие',
    occurred_at: 'Дата',
    reported_on: 'Дата сообщения',
    territory_id: 'Район',
    assignee: 'Исполнитель',
    unit_id: 'Подразделение',
    tags: 'Метки',
    geom: 'Место',
    is_confirmed: 'Подтверждено',
    response: 'Время реагирования',
    ratio: 'Доля',
    phone: 'Телефон',
    start_time: 'Начало',
    meta: 'Сведения',
    score_formula: 'Оценка',
    share: 'Процент',
    code: 'Код',
    email: 'Почта',
    notes: 'Заметки',
  },
  regions: { territory_id: 'Район', name: 'Название региона', population: 'Население' },
  archive: {
    title: 'Название',
    kind: 'Вид',
    damage: 'Ущерб',
    occurred_at: 'Дата',
    reported_on: 'Дата сообщения',
  },
  staff: {
    name: 'ФИО',
    salary: 'Оклад',
    phone: 'Телефон',
    email: 'Почта',
    hired_on: 'Дата найма',
    unit_id: 'Подразделение',
    passport: 'Паспорт',
  },
}

const EXTRA_LABELS: Record<string, { tg?: string; en?: string }> = {
  title: { tg: 'Ном', en: 'Title' },
  damage: { en: 'Damage' },
}

function named(dataset: ResolvedDataset, name: string, labels: Record<string, string>): SqlDataset {
  return {
    ...dataset,
    name,
    fields: dataset.fields.map((field) => ({
      ...field,
      label: { ru: labels[field.key] ?? field.key, ...EXTRA_LABELS[field.key] },
    })),
  }
}

export const sqlIncidents = named(
  incidents,
  'Происшествия',
  LABELS.incidents as Record<string, string>,
)
export const sqlRegions = named(regions, 'Регионы', LABELS.regions as Record<string, string>)
export const sqlArchive = named(
  archive,
  'Архив происшествий',
  LABELS.archive as Record<string, string>,
)
export const sqlStaff = named(staff, 'Сотрудники', LABELS.staff as Record<string, string>)

/** Контекст сырого SQL: пользователь и время — как у QuerySpec, датасеты — с именами. */
export function sqlCtx(overrides: Partial<RawSqlContext> = {}): RawSqlContext {
  const { datasets: _datasets, ...base } = ctx()
  return {
    ...base,
    datasets: [sqlIncidents, sqlRegions, sqlArchive, sqlStaff],
    ...overrides,
  }
}

/** Контекст с заменой датасетов по идентификатору (политики, физические таблицы). */
export function withSqlDatasets(
  list: readonly SqlDataset[],
  ...overrides: SqlDataset[]
): Pick<RawSqlContext, 'datasets'> {
  const byId = new Map(list.map((dataset) => [dataset.id, dataset]))
  for (const dataset of overrides) byId.set(dataset.id, dataset)
  return { datasets: [...byId.values()] }
}

/** Эталонное представление результата для снимков. */
export function renderSql(compiled: CompiledRawSql): string {
  const fields =
    compiled.fields === null
      ? 'неизвестны до выполнения'
      : compiled.fields
          .map((field) => `${field.name ?? '?'}:${field.field?.type ?? '—'}`)
          .join(', ')
  return [
    compiled.sql,
    `-- params: ${JSON.stringify(compiled.params)}`,
    `-- fields: ${fields}`,
  ].join('\n')
}
