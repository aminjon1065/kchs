import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { TaskListItem } from '../tasks/task.js'

/**
 * Резолюции (08-documents.md §6, ADR-0084): запись руководителя по
 * зарегистрированному документу — текст, ответственный, соисполнители, срок,
 * контроль. Сохранение резолюции в той же транзакции создаёт поручения модуля
 * задач; вложенная резолюция (руководитель управления → начальник отдела)
 * пишется ответственным или соисполнителем родительской.
 */

/** Срок резолюции: дата (конец дня) или «N рабочих дней» по производственному календарю. */
const ResolutionWorkingDays = z.number().int().min(1).max(366)

export const ResolutionRecord = z.object({
  id: Uuid,
  documentId: Uuid,
  parentId: Uuid.nullable(),
  author: UserRef,
  /** Резолюцию внёс делопроизводитель (помощник) от имени автора. */
  enteredBy: UserRef.nullable(),
  text: z.string(),
  responsible: UserRef,
  coExecutors: z.array(UserRef),
  dueDate: DateOnly,
  /** Срок задан рабочими днями — сколько их было. */
  dueWorkingDays: z.number().int().nullable(),
  control: z.boolean(),
  controller: UserRef.nullable(),
  createdAt: Timestamp,
  /** Поручения резолюции, видимые смотрящему: основное и части соисполнителей. */
  instructions: z.array(TaskListItem),
  /** Поручений резолюции всего и открытых — по всем, в том числе невидимым смотрящему. */
  total: z.number().int(),
  open: z.number().int(),
  /** Смотрящий может наложить вложенную резолюцию (ответственный или соисполнитель). */
  canNest: z.boolean(),
})
export type ResolutionRecord = z.infer<typeof ResolutionRecord>

/**
 * Направление на резолюцию: `open` — ждёт руководителя; `resolved` — резолюция
 * наложена; `no_execution` — «не требует исполнения»; `forwarded` —
 * переадресовано другому руководителю; `cancelled` — снято.
 */
export const RESOLUTION_REQUEST_STATES = [
  'open',
  'resolved',
  'no_execution',
  'forwarded',
  'cancelled',
] as const
export const ResolutionRequestState = z.enum(RESOLUTION_REQUEST_STATES)
export type ResolutionRequestState = z.infer<typeof ResolutionRequestState>

export const ResolutionRequestRecord = z.object({
  id: Uuid,
  user: UserRef,
  requestedBy: UserRef.nullable(),
  requestedAt: Timestamp,
  dueDate: DateOnly.nullable(),
  note: z.string().nullable(),
  state: ResolutionRequestState,
  closedAt: Timestamp.nullable(),
  /** Комментарий «не требует исполнения» или переадресации. */
  comment: z.string().nullable(),
})
export type ResolutionRequestRecord = z.infer<typeof ResolutionRequestRecord>

/** Вкладка «Резолюции и поручения»: резолюции деревом (`parentId`), направления, права. */
export const DocumentResolutions = z.object({
  items: z.array(ResolutionRecord),
  requests: z.array(ResolutionRequestRecord),
  can: z.object({
    /** Наложить резолюцию: у смотрящего (или замещаемого) открыто направление. */
    resolve: z.boolean(),
    /** Внести резолюцию от имени руководителя — делопроизводитель. */
    resolveOnBehalf: z.boolean(),
    /** Направить на резолюцию (делопроизводитель или получатель направления). */
    request: z.boolean(),
    /** «Не требует исполнения»: документ зарегистрирован, поручений нет. */
    noExecution: z.boolean(),
  }),
  /** Автор резолюции по умолчанию: получатель открытого направления (я или замещаемый). */
  defaultAuthor: UserRef.nullable(),
})
export type DocumentResolutions = z.infer<typeof DocumentResolutions>

export const ResolutionInput = z
  .object({
    text: z.string().trim().min(1).max(4000),
    responsibleId: Uuid,
    coExecutorIds: z.array(Uuid).max(20).default([]),
    dueDate: DateOnly.optional(),
    dueWorkingDays: ResolutionWorkingDays.optional(),
    /** На контроле: контролёр принимает отчёты вместе с автором. */
    control: z.boolean().default(true),
    /** Контролёр; по умолчанию — контролёр документа, иначе зарегистрировавший его. */
    controllerId: Uuid.nullable().optional(),
    /** Вложенная резолюция: родительская, где пишущий — ответственный или соисполнитель. */
    parentId: Uuid.nullable().default(null),
    /** Автор, если резолюцию вносит делопроизводитель от имени руководителя. */
    authorId: Uuid.optional(),
  })
  .superRefine((input, context) => {
    if ((input.dueDate === undefined) === (input.dueWorkingDays === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['dueDate'],
        message: 'Срок задаётся датой или числом рабочих дней',
      })
    }
    if (input.coExecutorIds.includes(input.responsibleId)) {
      context.addIssue({
        code: 'custom',
        path: ['coExecutorIds'],
        message: 'Ответственный не может быть соисполнителем',
      })
    }
  })
export type ResolutionInput = z.infer<typeof ResolutionInput>

/** Направить документ на резолюцию руководителю (или переадресовать). */
export const ResolutionRequestInput = z.object({
  userId: Uuid,
  dueDate: DateOnly.nullable().default(null),
  note: z.string().trim().max(2000).nullable().default(null),
})
export type ResolutionRequestInput = z.infer<typeof ResolutionRequestInput>

/** «Не требует исполнения» — зарегистрированный документ исполнен без поручений. */
export const NoExecutionInput = z.object({
  comment: z.string().trim().max(2000).nullable().default(null),
})
export type NoExecutionInput = z.infer<typeof NoExecutionInput>

/** Шаблон резолюции: общий (ведёт канцелярия) или личный. */
export const ResolutionTemplate = z.object({
  id: Uuid,
  text: z.string(),
  dueWorkingDays: z.number().int().nullable(),
  control: z.boolean(),
  shared: z.boolean(),
  canEdit: z.boolean(),
})
export type ResolutionTemplate = z.infer<typeof ResolutionTemplate>

export const ResolutionTemplateInput = z.object({
  text: z.string().trim().min(1).max(1000),
  dueWorkingDays: ResolutionWorkingDays.nullable().default(null),
  control: z.boolean().default(true),
  /** Общий шаблон — способность ведения справочников документооборота. */
  shared: z.boolean().default(false),
})
export type ResolutionTemplateInput = z.infer<typeof ResolutionTemplateInput>

export const ResolutionTemplateUpdateInput = z.object({
  text: z.string().trim().min(1).max(1000).optional(),
  dueWorkingDays: ResolutionWorkingDays.nullable().optional(),
  control: z.boolean().optional(),
})
export type ResolutionTemplateUpdateInput = z.infer<typeof ResolutionTemplateUpdateInput>
