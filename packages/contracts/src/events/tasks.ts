import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Задачи и поручения» (10-tasks-projects.md). Домены `task`, `project` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const TASKS_EVENTS = {
  // ── tasks (10-tasks-projects.md, ADR-0060) ─────────────────────────────────
  'task.created': z.object({ key: z.string(), kind: z.string(), assigneeId: Uuid.nullable() }),
  'task.assigned': z.object({
    key: z.string(),
    assigneeId: Uuid,
    previousAssigneeId: Uuid.nullable(),
    /** Основание переназначения (автором или контролёром, ADR-0082). */
    comment: z.string().nullable().optional(),
  }),
  /** Исполнитель принял поручение к исполнению. */
  'task.accepted': z.object({ key: z.string() }),
  'task.status_changed': z.object({
    key: z.string(),
    kind: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  'task.due_changed': z.object({
    key: z.string(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  'task.reported': z.object({ key: z.string() }),
  'task.report_prepared': z.object({ key: z.string(), cause: z.string() }),
  /** Чек-лист изменился: пункт добавлен, отмечен, переименован, убран (ADR-0155). */
  'task.checklist_changed': z.object({
    key: z.string(),
    done: z.number().int(),
    total: z.number().int(),
    change: z.enum(['added', 'checked', 'unchecked', 'renamed', 'moved', 'removed']),
    item: z.string(),
  }),
  /** Автор или контролёр принял отчёт — поручение закрыто. */
  'task.completed': z.object({ key: z.string() }),
  'task.returned': z.object({ key: z.string(), comment: z.string() }),
  /** Территория задачи изменилась (паспорт территории, ADR-0077). */
  'task.territory_changed': z.object({
    key: z.string(),
    from: Uuid.nullable(),
    to: Uuid.nullable(),
  }),
  // Поручения в полном режиме (ADR-0082)
  /** Исполнитель просит продлить срок: решение — за автором. */
  'task.extension_requested': z.object({
    key: z.string(),
    extensionId: Uuid,
    from: z.string().nullable(),
    to: z.string(),
    reason: z.string(),
  }),
  /** Автор согласовал продление (новый срок — `to`) или отказал. */
  'task.extension_decided': z.object({
    key: z.string(),
    extensionId: Uuid,
    decision: z.enum(['approved', 'rejected']),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** Напоминание о сроке: за 3 и за 1 рабочий день, в день срока. */
  'task.due_soon': z.object({
    key: z.string(),
    stage: z.enum(['d3', 'd1', 'today']),
    dueAt: z.string(),
    workingDaysLeft: z.number().int(),
  }),
  /** Срок прошёл, поручение не закрыто. */
  'task.overdue': z.object({ key: z.string(), dueAt: z.string() }),
  /** Просрочка передана руководителю исполнителя. */
  'task.escalated': z.object({
    key: z.string(),
    dueAt: z.string(),
    managerId: Uuid,
    afterWorkingDays: z.number().int(),
  }),
  /**
   * Все поручения источника (документа, объекта) закрыты — приняты или отменены:
   * документ может перейти в «Исполнен» (08-documents.md §6).
   */
  'task.source_closed': z.object({
    sourceObjectId: Uuid,
    sourceKind: z.string(),
    resolutionIds: z.array(Uuid),
    total: z.number().int(),
    accepted: z.number().int(),
    cancelled: z.number().int(),
  }),
  'project.created': z.object({ key: z.string(), name: z.string() }),
} as const satisfies Record<string, z.ZodType>
