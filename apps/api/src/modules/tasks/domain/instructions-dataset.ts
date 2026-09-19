import type { FieldFormat, FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import { visibilityPrincipals } from '~/kernel/access/authorize.js'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
  format?: FieldFormat,
): ResolvedField => ({ key, type, physical: key, semantic, label, ...(format ? { format } : {}) })

/**
 * Поля представления `ds.sys_instructions` (миграция instructions_control):
 * поручения с состоянием контроля исполнения — `state` (`open`, `overdue`,
 * `done_on_time`, `done_late`, `cancelled`), отметкой «продлено», днями
 * просрочки и подразделением исполнителя (08-documents.md §7, ADR-0082).
 */
const FIELDS: ResolvedField[] = [
  field('id', 'object_ref', 'identifier', { ru: 'Поручение', tg: 'Супориш', en: 'Instruction' }),
  field('key', 'identifier', 'identifier', { ru: 'Номер', tg: 'Рақам', en: 'Number' }),
  field('title', 'text', 'text', { ru: 'Содержание', tg: 'Мазмун', en: 'Title' }),
  field('status', 'select', 'category', { ru: 'Статус', tg: 'Ҳолат', en: 'Status' }),
  field('state', 'select', 'category', {
    ru: 'Состояние контроля',
    tg: 'Ҳолати назорат',
    en: 'Control state',
  }),
  field('priority', 'integer', 'category', { ru: 'Приоритет', tg: 'Афзалият', en: 'Priority' }),
  field('assignee', 'user', 'dimension', { ru: 'Исполнитель', tg: 'Иҷрокунанда', en: 'Assignee' }),
  field('author', 'user', 'dimension', { ru: 'Автор', tg: 'Муаллиф', en: 'Author' }),
  field('controller', 'user', 'dimension', { ru: 'Контролёр', tg: 'Назоратчӣ', en: 'Controller' }),
  field('unit', 'unit', 'dimension', {
    ru: 'Подразделение исполнителя',
    tg: 'Воҳиди иҷрокунанда',
    en: 'Assignee unit',
  }),
  field('parent', 'object_ref', 'dimension', {
    ru: 'Основное поручение',
    tg: 'Супориши асосӣ',
    en: 'Main instruction',
  }),
  field('is_part', 'boolean', 'category', {
    ru: 'Часть соисполнителя',
    tg: 'Қисми ҳамиҷрокунанда',
    en: 'Co-assignee part',
  }),
  field('source_kind', 'select', 'category', {
    ru: 'Вид источника',
    tg: 'Навъи манбаъ',
    en: 'Source kind',
  }),
  field('source', 'object_ref', 'dimension', { ru: 'Источник', tg: 'Манбаъ', en: 'Source' }),
  field('space', 'object_ref', 'dimension', { ru: 'Пространство', tg: 'Фазо', en: 'Space' }),
  field('due_at', 'datetime', 'time', { ru: 'Срок', tg: 'Мӯҳлат', en: 'Due' }),
  field('original_due_at', 'datetime', 'time', {
    ru: 'Первоначальный срок',
    tg: 'Мӯҳлати аввала',
    en: 'Original due',
  }),
  field('started_at', 'datetime', 'time', {
    ru: 'Принято к исполнению',
    tg: 'Барои иҷро қабул шуд',
    en: 'Started',
  }),
  field('reported_at', 'datetime', 'time', { ru: 'Отчёт', tg: 'Ҳисобот', en: 'Reported' }),
  field('completed_at', 'datetime', 'time', { ru: 'Закрыто', tg: 'Баста шуд', en: 'Completed' }),
  field('created_at', 'datetime', 'time', { ru: 'Выдано', tg: 'Дода шуд', en: 'Issued' }),
  field('extensions', 'integer', 'measure', {
    ru: 'Продлений',
    tg: 'Тамдидҳо',
    en: 'Extensions',
  }),
  field('extended', 'boolean', 'category', { ru: 'Продлено', tg: 'Тамдид шуд', en: 'Extended' }),
  field('overdue', 'boolean', 'category', {
    ru: 'Просрочено',
    tg: 'Мӯҳлаташ гузашт',
    en: 'Overdue',
  }),
  field('on_time', 'boolean', 'category', {
    ru: 'Исполнено в срок',
    tg: 'Сари вақт иҷро шуд',
    en: 'Done on time',
  }),
  // 100 или 0 у принятого поручения со сроком: среднее — доля в срок в процентах
  field(
    'on_time_score',
    'integer',
    'measure',
    { ru: 'Исполнено в срок, %', tg: 'Сари вақт иҷро шуд, %', en: 'Done on time, %' },
    { precision: 0 },
  ),
  field('days_late', 'integer', 'measure', {
    ru: 'Дней просрочки',
    tg: 'Рӯзҳои гузашта',
    en: 'Days late',
  }),
  // Служебный столбец политики строк — скрыт от смотрящего
  field('viewers', 'multi_select', 'system', { ru: 'Видят', en: 'Viewers' }),
]

/**
 * Источник компилятора с правами смотрящего: строки — поручения, чьи принципалы
 * пересекаются с принципалами пользователя, включая `unit_head:<id>` —
 * руководитель видит поручения подчинённых (ADR-0060, ADR-0082).
 */
export async function resolveInstructionsDataset(ctx: Ctx): Promise<ResolvedDataset> {
  const principals = visibilityPrincipals(ctx)
  return {
    id: 'system:instructions',
    table: 'ds.sys_instructions',
    fields: FIELDS,
    rowPolicy:
      principals === null
        ? { kind: 'all' }
        : principals.length === 0
          ? { kind: 'none' }
          : { kind: 'filter', where: { field: 'viewers', op: 'in', value: principals } },
    columnPolicy: { hide: ['viewers'], mask: [] },
    version: 0,
    systemColumns: false,
  }
}

export const INSTRUCTIONS_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'instructions',
  resolve: resolveInstructionsDataset,
  timeField: 'due_at',
}
