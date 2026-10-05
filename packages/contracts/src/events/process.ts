import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Движок процессов (02-platform-kernel.md §10). Домены `process` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const PROCESS_EVENTS = {
  // ── process (02-platform-kernel.md §10, ADR-0079) ─────────────────────────
  // Объект события — объект маршрута; stepId — активация шага, stepKey — шаг определения
  'process.started': z.object({
    instanceId: Uuid,
    definitionKey: z.string(),
    version: z.number().int(),
    name: z.string(),
  }),
  /** Шаг активирован: назначенные (для notify — получатели), срок по календарю. */
  'process.step_activated': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    assignees: z.array(Uuid),
    dueAt: z.string().nullable(),
    template: z.string().nullable().default(null),
  }),
  /** Решение назначенного; userId — чья очередь, actor события — кто нажал. */
  'process.step_decided': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    decision: z.string(),
    userId: Uuid,
  }),
  'process.step_completed': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    outcome: z.string(),
  }),
  /** Состав назначенных изменился: добавлен согласующий, шаг передан, переназначен. */
  'process.step_assignees_changed': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    added: z.array(Uuid),
    removed: z.array(Uuid),
    reason: z.enum(['added', 'delegated', 'reassigned']),
  }),
  /** Напоминание о сроке: за рабочий день и в день срока. */
  'process.step_due_soon': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    dueAt: z.string(),
    userIds: z.array(Uuid),
    /** За рабочий день, в день срока или незадолго до часового срока (ADR-0131). */
    when: z.enum(['before', 'due_day', 'soon']),
  }),
  /** Срок шага истёк: не ответившие и получатели эскалации по таймерам определения. */
  'process.step_overdue': z.object({
    instanceId: Uuid,
    stepId: Uuid,
    stepKey: z.string(),
    kind: z.string(),
    dueAt: z.string(),
    userIds: z.array(Uuid),
    escalateTo: z.array(Uuid),
  }),
  'process.finished': z.object({
    instanceId: Uuid,
    definitionKey: z.string(),
    status: z.enum(['finished', 'cancelled']),
    outcome: z.string(),
  }),
  /** Определение маршрута: черновик сохранён или снят, версия опубликована. */
  'process.definition_changed': z.object({
    key: z.string(),
    version: z.number().int(),
    change: z.enum(['draft_saved', 'draft_discarded', 'published']),
  }),
} as const satisfies Record<string, z.ZodType>
