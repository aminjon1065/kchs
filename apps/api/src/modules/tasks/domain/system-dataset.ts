import type { FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { ResolvedDataset, ResolvedField } from '@kchs/query'
import { visibilityPrincipals } from '~/kernel/access/authorize.js'
import type { SystemDatasetDefinition } from '~/kernel/system-datasets.js'
import type { Ctx } from '~/shared/context.js'

const field = (
  key: string,
  type: FieldType,
  semantic: FieldSemantic,
  label: LangText,
  physical = key,
): ResolvedField => ({ key, type, physical, semantic, label })

/**
 * Поля представления `ds.sys_tasks` (миграция tasks_phase1): задачи с правами
 * смотрящего для запросов, графиков и показателей — просроченные, выполненные
 * в срок, время исполнения (10-tasks-projects.md §6, P1-E04 S05).
 */
const FIELDS: ResolvedField[] = [
  field('id', 'object_ref', 'identifier', { ru: 'Задача', tg: 'Вазифа', en: 'Task' }),
  field('key', 'identifier', 'identifier', { ru: 'Ключ', tg: 'Калид', en: 'Key' }),
  field('title', 'text', 'text', { ru: 'Название', tg: 'Ном', en: 'Title' }),
  field('kind', 'select', 'category', { ru: 'Вид', tg: 'Намуд', en: 'Kind' }),
  field('status', 'select', 'category', { ru: 'Статус', tg: 'Ҳолат', en: 'Status' }),
  field('priority', 'integer', 'category', { ru: 'Приоритет', tg: 'Афзалият', en: 'Priority' }),
  field('assignee', 'user', 'dimension', { ru: 'Исполнитель', tg: 'Иҷрокунанда', en: 'Assignee' }),
  field('author', 'user', 'dimension', { ru: 'Автор', tg: 'Муаллиф', en: 'Author' }),
  field('controller', 'user', 'dimension', { ru: 'Контролёр', tg: 'Назоратчӣ', en: 'Controller' }),
  field('project', 'object_ref', 'dimension', { ru: 'Проект', tg: 'Лоиҳа', en: 'Project' }),
  field('space', 'object_ref', 'dimension', { ru: 'Пространство', tg: 'Фазо', en: 'Space' }),
  field('due_at', 'datetime', 'time', { ru: 'Срок', tg: 'Мӯҳлат', en: 'Due' }),
  field('started_at', 'datetime', 'time', {
    ru: 'Принято к исполнению',
    tg: 'Барои иҷро қабул шуд',
    en: 'Started',
  }),
  field('reported_at', 'datetime', 'time', { ru: 'Отчёт', tg: 'Ҳисобот', en: 'Reported' }),
  field('completed_at', 'datetime', 'time', { ru: 'Закрыта', tg: 'Баста шуд', en: 'Completed' }),
  field('created_at', 'datetime', 'time', { ru: 'Создана', tg: 'Сохта шуд', en: 'Created' }),
  field('overdue', 'boolean', 'category', {
    ru: 'Просрочена',
    tg: 'Мӯҳлаташ гузашт',
    en: 'Overdue',
  }),
  field('on_time', 'boolean', 'category', { ru: 'В срок', tg: 'Сари вақт', en: 'On time' }),
  // Служебный столбец политики строк — скрыт от смотрящего
  field('viewers', 'multi_select', 'system', { ru: 'Видят', en: 'Viewers' }),
]

/**
 * Источник компилятора с правами смотрящего: строки — задачи, чьи принципалы
 * пересекаются с принципалами пользователя (как фильтр поиска, ADR-0060).
 */
export async function resolveTasksDataset(ctx: Ctx): Promise<ResolvedDataset> {
  const principals = visibilityPrincipals(ctx)
  return {
    id: 'system:tasks',
    table: 'ds.sys_tasks',
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

export const TASKS_SYSTEM_DATASET: SystemDatasetDefinition = {
  name: 'tasks',
  resolve: resolveTasksDataset,
}
