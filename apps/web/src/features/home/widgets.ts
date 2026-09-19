/**
 * Виджеты «Мой день» (12-calendar-notifications-home.md §4, P0-E15 S01):
 * пользователь выбирает, что показывать и в каком порядке; пока не выбрал —
 * набор по его роли. «Выданные мной» и «Команда» — поручения на контроле и
 * подчинённые руководителя (ADR-0082; «Команда» не показывается тому, у кого
 * нет подчинённых), «Сегодня» — встречи и сроки дня (ADR-0081). «Показатели» и
 * другие виджеты появятся вместе со своими модулями.
 */
export const HOME_WIDGETS = [
  'inbox',
  'today',
  'tasks',
  'assigned',
  'team',
  'announcements',
  'continue',
  'recent',
  'pinned',
] as const
export type HomeWidget = (typeof HOME_WIDGETS)[number]

/** Ключ пользовательской настройки (`PUT /me/preferences`). */
export const HOME_WIDGETS_PREFERENCE = 'home.widgets'

const DEFAULT_WIDGETS: HomeWidget[] = [
  'inbox',
  'today',
  'tasks',
  'assigned',
  'team',
  'announcements',
  'continue',
  'recent',
  'pinned',
]

/** Первое совпадение по порядку: у сотрудника с несколькими ролями — самая «рабочая». */
const ROLE_PRESETS: ReadonlyArray<{ roles: readonly string[]; widgets: HomeWidget[] }> = [
  // Делопроизводитель: Входящие, «Сегодня», поручения и выданные на контроль
  {
    roles: ['registrar'],
    widgets: ['inbox', 'today', 'tasks', 'assigned', 'announcements', 'recent'],
  },
  // Аналитик: продолжить работу и закреплённые представления (свежесть данных — фаза 1)
  {
    roles: ['data_steward', 'gis_admin'],
    widgets: ['continue', 'pinned', 'today', 'tasks', 'recent', 'announcements', 'inbox'],
  },
  // Администраторы: объявления, которые они же публикуют, и Входящие
  {
    roles: ['system_admin', 'org_admin', 'security_auditor'],
    widgets: ['announcements', 'inbox', 'today', 'tasks', 'recent', 'continue'],
  },
]

export function presetFor(roles: readonly string[]): HomeWidget[] {
  const preset = ROLE_PRESETS.find((item) => item.roles.some((role) => roles.includes(role)))
  return [...(preset?.widgets ?? DEFAULT_WIDGETS)]
}

const isWidget = (value: unknown): value is HomeWidget =>
  typeof value === 'string' && (HOME_WIDGETS as readonly string[]).includes(value)

/**
 * Показываемые виджеты: сохранённый выбор (без исчезнувших и повторов) или
 * набор по роли. Пустой сохранённый список — осознанный выбор «ничего».
 */
export function widgetsFor(preference: unknown, roles: readonly string[]): HomeWidget[] {
  if (!Array.isArray(preference)) return presetFor(roles)
  const known = [...new Set(preference.filter(isWidget))]
  return known.length > 0 || preference.length === 0 ? known : presetFor(roles)
}
