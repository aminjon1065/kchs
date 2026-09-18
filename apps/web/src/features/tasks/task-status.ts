import {
  TASK_STATUS_CATEGORY,
  type TaskListItem,
  type TaskStatus,
  type TaskStatusCategory,
  type UserRef,
} from '@kchs/contracts'
import type { PickedUser } from './user-picker.js'

/** Тон значка статуса — ключ из `STATUS_TONES` дизайн-системы. */
export const STATUS_TONE_KEY: Record<TaskStatus, string> = {
  todo: 'todo',
  assigned: 'todo',
  in_progress: 'in_progress',
  returned: 'returned',
  review: 'review',
  reported: 'review',
  done: 'done',
  accepted: 'accepted',
  cancelled: 'cancelled',
}

/** Колонки общей доски задач и поручений: категории статусов без «Отменено». */
export const BOARD_COLUMNS: TaskStatusCategory[] = ['todo', 'in_progress', 'review', 'done']

/** Приоритеты P1 (срочно) … P4 (низкий). */
export const PRIORITIES = [1, 2, 3, 4] as const

/** Статус перехода, в который ведёт действие поручения, — для доски до ответа сервера. */
export const ACTION_STATUS: Record<'start' | 'report' | 'accept', TaskStatus> = {
  start: 'in_progress',
  report: 'reported',
  accept: 'accepted',
}

export type BoardMove =
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'action'; action: 'start' | 'report' | 'accept' }
  | null

/**
 * Перенос карточки в колонку доски: у задачи — статус этой категории из её
 * переходов; у поручения — действие, которое ведёт в колонку (принять,
 * отчитаться, принять отчёт). Возврат и отмену с замечаниями доска не делает —
 * только карточка.
 */
export function boardMove(
  item: Pick<TaskListItem, 'kind' | 'can'>,
  column: TaskStatusCategory,
): BoardMove {
  const target = item.can.transitions.find((status) => TASK_STATUS_CATEGORY[status] === column)
  if (!target) return null
  if (item.kind !== 'instruction') return { kind: 'status', status: target }
  if (target === 'in_progress') return { kind: 'action', action: 'start' }
  if (target === 'reported') return { kind: 'action', action: 'report' }
  if (target === 'accepted') return { kind: 'action', action: 'accept' }
  return null
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Срок — конец выбранного дня по часам пользователя: `YYYY-MM-DD` → ISO 8601. */
export function dueFromDate(date: string): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 23, 59, 59).toISOString()
}

/** Участник задачи — значение выбора сотрудника в диалоге правки. */
export function pickedOf(user: UserRef | null): PickedUser | null {
  if (!user) return null
  return {
    id: user.id,
    title: user.displayName,
    subtitle: user.position,
    avatarUrl: user.avatarUrl,
  }
}

/** День срока по часам пользователя для поля даты. */
export function dateFromDue(due: string | null): string {
  if (!due) return ''
  const date = new Date(due)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
