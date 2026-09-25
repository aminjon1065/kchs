import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { TaskPriority, TaskProjectRef } from './task.js'

/**
 * Повторяющиеся поручения и задачи (ADR-0156): серия — объект реестра с шаблоном и
 * правилом; экземпляры создаёт задание по расписанию от имени автора серии, по одному
 * на дату правила.
 */
export const TASK_SERIES_FREQS = ['daily', 'weekly', 'monthly'] as const
export const TaskSeriesFreq = z.enum(TASK_SERIES_FREQS)
export type TaskSeriesFreq = z.infer<typeof TaskSeriesFreq>

export const TaskSeriesRule = z
  .object({
    freq: TaskSeriesFreq,
    /** Каждые N дней, недель или месяцев. */
    interval: z.number().int().min(1).max(12).default(1),
    /** Дни недели ISO (1 — понедельник, 7 — воскресенье) — для еженедельного правила. */
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    /** Число месяца, -1 — последний день; 31 в коротком месяце — последнее число. */
    monthDay: z
      .number()
      .int()
      .min(-1)
      .max(31)
      .refine((value) => value !== 0, { message: 'Число месяца — от 1 до 31 или «последний день»' })
      .default(1),
    /** Время создания экземпляра по часам организации. */
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время — ЧЧ:ММ')
      .default('09:00'),
  })
  .superRefine((rule, context) => {
    if (rule.freq === 'weekly' && rule.weekdays.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['weekdays'],
        message: 'Выберите хотя бы один день недели',
      })
    }
  })
export type TaskSeriesRule = z.infer<typeof TaskSeriesRule>

export const TASK_SERIES_STATUSES = ['active', 'paused', 'stopped'] as const
export const TaskSeriesStatus = z.enum(TASK_SERIES_STATUSES)
export type TaskSeriesStatus = z.infer<typeof TaskSeriesStatus>

const Title = z.string().trim().min(1).max(300)
const Description = z.string().trim().max(20_000)

/** Шаблон экземпляра: то, что получит каждое поручение серии. */
export const TaskSeriesTemplate = z.object({
  kind: z.enum(['task', 'instruction']).default('instruction'),
  title: Title,
  description: Description.nullable().optional(),
  projectId: Uuid.nullable().optional(),
  spaceId: Uuid.nullable().optional(),
  assigneeId: Uuid.nullable().optional(),
  coAssigneeIds: z.array(Uuid).max(20).default([]),
  controllerId: Uuid.nullable().optional(),
  priority: TaskPriority.default(3),
  labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
})
export type TaskSeriesTemplate = z.infer<typeof TaskSeriesTemplate>

export const TaskSeriesCreateInput = z
  .object({
    template: TaskSeriesTemplate,
    rule: TaskSeriesRule,
    /** Срок экземпляра — N рабочих дней от даты создания по производственному календарю. */
    dueWorkingDays: z.number().int().min(1).max(366).default(1),
    startsOn: DateOnly,
    endsOn: DateOnly.nullable().optional(),
    /** Сколько экземпляров создать всего; пусто — без ограничения. */
    maxCount: z.number().int().min(1).max(1000).nullable().optional(),
  })
  .superRefine((input, context) => {
    if (input.template.kind === 'instruction' && !input.template.assigneeId) {
      context.addIssue({
        code: 'custom',
        path: ['template', 'assigneeId'],
        message: 'У поручения должен быть исполнитель',
      })
    }
    if (input.endsOn && input.endsOn < input.startsOn) {
      context.addIssue({
        code: 'custom',
        path: ['endsOn'],
        message: 'Окончание серии — не раньше начала',
      })
    }
  })
export type TaskSeriesCreateInput = z.infer<typeof TaskSeriesCreateInput>

/** Правка серии: действует на будущие экземпляры, созданные остаются как есть. */
export const TaskSeriesPatch = z
  .object({
    title: Title,
    description: Description.nullable(),
    assigneeId: Uuid.nullable(),
    controllerId: Uuid.nullable(),
    priority: TaskPriority,
    rule: TaskSeriesRule,
    dueWorkingDays: z.number().int().min(1).max(366),
    endsOn: DateOnly.nullable(),
    maxCount: z.number().int().min(1).max(1000).nullable(),
  })
  .partial()
export type TaskSeriesPatch = z.infer<typeof TaskSeriesPatch>

export const TaskSeriesRecord = z.object({
  id: Uuid,
  kind: z.enum(['task', 'instruction']),
  title: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid.nullable(),
  project: TaskProjectRef.nullable(),
  author: UserRef.nullable(),
  assignee: UserRef.nullable(),
  controller: UserRef.nullable(),
  priority: TaskPriority,
  rule: TaskSeriesRule,
  dueWorkingDays: z.number().int(),
  startsOn: DateOnly,
  endsOn: DateOnly.nullable(),
  maxCount: z.number().int().nullable(),
  status: TaskSeriesStatus,
  /** Почему серия встала сама: автор больше не может создавать поручения. */
  statusReason: z.string().nullable(),
  createdCount: z.number().int(),
  lastOccurrence: DateOnly.nullable(),
  nextRunAt: Timestamp.nullable(),
  can: z.object({ edit: z.boolean() }),
})
export type TaskSeriesRecord = z.infer<typeof TaskSeriesRecord>

export const TaskSeriesList = z.object({ items: z.array(TaskSeriesRecord) })
export type TaskSeriesList = z.infer<typeof TaskSeriesList>
