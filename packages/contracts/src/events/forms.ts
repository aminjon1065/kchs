import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { empty } from './shared.js'

/**
 * События: Модуль «Формы сбора» (06-analytics-engine.md §13). Домены `form` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const FORMS_EVENTS = {
  // ── формы сбора данных (06-analytics-engine.md §13, ADR-0103) ─────────────
  'form.created': z.object({ datasetId: Uuid, periodicity: z.string() }),
  'form.updated': z.object({ changed: z.array(z.string()).default([]) }),
  'form.enabled': z.object({ assignments: z.number().int().nonnegative() }),
  'form.disabled': empty,
  /** Период открыт назначенному: у него появилось дело «Сдать сводку». */
  'form.assigned': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp.nullable().default(null),
  }),
  /**
   * Сводка сдана: строки датасета записаны отправкой. У одиночной формы
   * `rowId` — её строка; у табличной (ADR-0129) — `rowIds` и их число, `rowId` пуст.
   */
  'form.submitted': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    rowId: z.string().nullable().default(null),
    rowIds: z.array(z.string()).max(500).default([]),
    rowCount: z.number().int().nonnegative().default(0),
    resubmitted: z.boolean().default(false),
  }),
  /** Сводка принята ответственным. */
  'form.accepted': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    authorId: Uuid.nullable().default(null),
  }),
  /** Сводка возвращена на доработку с комментарием. */
  'form.returned': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    authorId: Uuid.nullable().default(null),
    comment: z.string(),
  }),
  /** Срок сдачи близок: назначенному напоминают. */
  'form.due_soon': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
  }),
  /** Срок сдачи прошёл, сводки нет. */
  'form.overdue': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
  }),
  /** Просрочка передана руководителю назначенного. */
  'form.escalated': z.object({
    submissionId: Uuid,
    periodKey: z.string(),
    subjectKind: z.string(),
    subjectId: Uuid,
    dueAt: Timestamp,
    managerId: Uuid,
  }),
} as const satisfies Record<string, z.ZodType>
