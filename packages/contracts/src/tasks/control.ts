import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { TaskListItem, TaskStatus } from './task.js'

/**
 * Контроль исполнения поручений (08-documents.md §7, 03-ui/03-screens.md §12,
 * ADR-0082). Считается запросами к системному датасету «Поручения» с правами
 * смотрящего: руководитель видит поручения подчинённых, контролёр — свои.
 *
 * Состояние поручения: открытое — в срок, срок сегодня или просрочено; принятое —
 * исполнено в срок или с опозданием; отменённые в контроль не входят. «Продлено»
 * — отметка поверх состояния: срок продлевали по запросу исполнителя.
 */
export const CONTROL_STATES = [
  'on_track',
  'due_today',
  'overdue',
  'done_on_time',
  'done_late',
] as const
export const ControlState = z.enum(CONTROL_STATES)
export type ControlState = z.infer<typeof ControlState>

/** Ячейки матрицы и ссылки на список: состояния, «продлено» и итог. */
export const CONTROL_BUCKETS = [...CONTROL_STATES, 'extended', 'total'] as const
export const ControlBucket = z.enum(CONTROL_BUCKETS)
export type ControlBucket = z.infer<typeof ControlBucket>

/** Источник поручения: резолюция документа, объект, строка датасета, без источника. */
export const CONTROL_SOURCES = ['any', 'resolution', 'object', 'dataset_row', 'none'] as const
export const ControlSource = z.enum(CONTROL_SOURCES)
export type ControlSource = z.infer<typeof ControlSource>

export const ControlQuery = z.object({
  /** Подразделение исполнителя вместе с вложенными. */
  unitId: Uuid.optional(),
  assigneeId: Uuid.optional(),
  controllerId: Uuid.optional(),
  authorId: Uuid.optional(),
  /** Срок исполнения с (включительно), день по часам смотрящего. */
  from: DateOnly.optional(),
  /** Срок исполнения по (включительно). */
  to: DateOnly.optional(),
  source: ControlSource.default('any'),
  /** Учитывать части соисполнителей; по умолчанию — только основные поручения. */
  parts: z.stringbool().default(false),
})
export type ControlQuery = z.infer<typeof ControlQuery>

export const ControlCounts = z.object({
  onTrack: z.number().int(),
  dueToday: z.number().int(),
  overdue: z.number().int(),
  doneOnTime: z.number().int(),
  doneLate: z.number().int(),
  /** Отметка поверх состояния: срок продлевали. */
  extended: z.number().int(),
  total: z.number().int(),
})
export type ControlCounts = z.infer<typeof ControlCounts>

/** Строка матрицы — подразделение исполнителя. */
export const ControlRow = z.object({
  /** null — исполнитель без подразделения. */
  unitId: Uuid.nullable(),
  unitName: z.string().nullable(),
  /** Путь в оргструктуре от корня до родителя: «Комитет › Управление». */
  unitPath: z.array(z.string()),
  counts: ControlCounts,
})
export type ControlRow = z.infer<typeof ControlRow>

/** Динамика по неделям срока исполнения. */
export const ControlWeek = z.object({
  /** Понедельник недели. */
  week: DateOnly,
  onTrack: z.number().int(),
  overdue: z.number().int(),
  doneOnTime: z.number().int(),
  doneLate: z.number().int(),
})
export type ControlWeek = z.infer<typeof ControlWeek>

/** Показатели контроля — обычные показатели над системным датасетом «Поручения». */
export const CONTROL_METRIC_KEYS = ['instructions.overdue', 'instructions.on_time_rate'] as const
export const ControlMetricKey = z.enum(CONTROL_METRIC_KEYS)
export type ControlMetricKey = z.infer<typeof ControlMetricKey>

export const ControlReport = z.object({
  rows: z.array(ControlRow),
  totals: ControlCounts,
  /** Доля исполненных в срок среди принятых; null — принятых нет. */
  onTimeRate: z.number().min(0).max(1).nullable(),
  weeks: z.array(ControlWeek),
  /** Заведённые показатели контроля, видимые смотрящему. */
  metrics: z.array(z.object({ key: ControlMetricKey, id: Uuid })),
  generatedAt: Timestamp,
})
export type ControlReport = z.infer<typeof ControlReport>

export const ControlListQuery = ControlQuery.extend({
  bucket: ControlBucket.default('overdue'),
  /** Строка матрицы: подразделение без вложенных; `none` — исполнители без подразделения. */
  row: z.union([Uuid, z.literal('none')]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type ControlListQuery = z.infer<typeof ControlListQuery>

export const ControlListItem = z.object({
  id: Uuid,
  key: z.string(),
  title: z.string(),
  status: TaskStatus,
  state: ControlState,
  assignee: UserRef.nullable(),
  author: UserRef.nullable(),
  controller: UserRef.nullable(),
  unitId: Uuid.nullable(),
  unitName: z.string().nullable(),
  dueAt: Timestamp.nullable(),
  completedAt: Timestamp.nullable(),
  extensions: z.number().int(),
  isPart: z.boolean(),
  /** Календарных дней просрочки: у просроченных — до сегодня, у исполненных поздно — до приёмки. */
  daysLate: z.number().int().nullable(),
})
export type ControlListItem = z.infer<typeof ControlListItem>

export const ControlList = z.object({
  items: z.array(ControlListItem),
  total: z.number().int(),
})
export type ControlList = z.infer<typeof ControlList>

export const CONTROL_EXPORT_FORMATS = ['csv', 'xlsx'] as const
export const ControlExportQuery = ControlQuery.extend({
  format: z.enum(CONTROL_EXPORT_FORMATS).default('xlsx'),
})
export type ControlExportQuery = z.infer<typeof ControlExportQuery>

// ─── Нагрузка (10-tasks-projects.md §6) ───────────────────────────────────────

export const WorkloadQuery = z.object({
  /** Сотрудники подразделения с вложенными; без него — подчинённые смотрящего. */
  unitId: Uuid.optional(),
  /** Сколько недель, начиная с текущей. */
  weeks: z.coerce.number().int().min(1).max(12).default(6),
})
export type WorkloadQuery = z.infer<typeof WorkloadQuery>

export const WorkloadCell = z.object({
  /** Понедельник недели срока. */
  week: DateOnly,
  /** Открытые задачи и поручения со сроком на этой неделе. */
  total: z.number().int(),
  instructions: z.number().int(),
})
export type WorkloadCell = z.infer<typeof WorkloadCell>

export const WorkloadPerson = z.object({
  user: UserRef,
  open: z.number().int(),
  overdue: z.number().int(),
  /** Открытые без срока. */
  noDue: z.number().int(),
  /** Со сроком позже показанных недель. */
  later: z.number().int(),
  cells: z.array(WorkloadCell),
})
export type WorkloadPerson = z.infer<typeof WorkloadPerson>

export const WorkloadReport = z.object({
  /** Чья нагрузка: подчинённые смотрящего, подразделение или сам смотрящий. */
  scope: z.enum(['subordinates', 'unit', 'self']),
  weeks: z.array(DateOnly),
  people: z.array(WorkloadPerson),
})
export type WorkloadReport = z.infer<typeof WorkloadReport>

// ─── «Мой день»: «Выданные мной» и «Команда» (12-calendar-notifications-home.md §4) ─

export const IssuedSummary = z.object({
  assigned: z.number().int(),
  inProgress: z.number().int(),
  returned: z.number().int(),
  /** Отчёты ждут приёмки. */
  reported: z.number().int(),
  overdue: z.number().int(),
  dueToday: z.number().int(),
  /** Запросы продления ждут решения. */
  extensionRequests: z.number().int(),
  /** Требуют внимания: отчёты, запросы продления, просроченные. */
  items: z.array(TaskListItem),
})
export type IssuedSummary = z.infer<typeof IssuedSummary>

export const TeamMember = z.object({
  user: UserRef,
  open: z.number().int(),
  overdue: z.number().int(),
  dueThisWeek: z.number().int(),
})
export type TeamMember = z.infer<typeof TeamMember>

export const TeamSummary = z.object({
  /** Смотрящий руководит подразделением: у него есть подчинённые. */
  manager: z.boolean(),
  members: z.array(TeamMember),
  overdue: z.array(TaskListItem),
})
export type TeamSummary = z.infer<typeof TeamSummary>

// ─── Настройки поручений ──────────────────────────────────────────────────────

/**
 * Эскалация просрочки руководителю исполнителя (10-tasks-projects.md §4):
 * включена ли и через сколько рабочих дней после срока (0 — вместе с просрочкой).
 */
export const TaskEscalationSettings = z.object({
  enabled: z.boolean(),
  afterWorkingDays: z.number().int().min(0).max(10),
})
export type TaskEscalationSettings = z.infer<typeof TaskEscalationSettings>

export const TaskSettings = z.object({ escalation: TaskEscalationSettings })
export type TaskSettings = z.infer<typeof TaskSettings>
