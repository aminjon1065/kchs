import { LangText, Timestamp, UserRef, Uuid } from '@kchs/contracts'
import { z } from 'zod'
import { DECISIONS } from './machine.js'
import { ProcessDefinition, STEP_TYPES } from './schema.js'

/**
 * Контракты HTTP API движка процессов (ADR-0079): определения маршрутов для
 * администратора и конструктора, экземпляры и линия шагов для экрана маршрута,
 * действия шага. Определение маршрута в теле запроса проверяется сервером
 * (`validateDefinition`) — ответ с проблемами, а не 400 схемы, чтобы конструктор
 * показал их на месте.
 */

export const DefinitionIssue = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
})
export type DefinitionIssue = z.infer<typeof DefinitionIssue>

export const ProcessDefinitionSummary = z.object({
  key: z.string(),
  objectType: z.string(),
  name: LangText,
  publishedVersion: z.number().int().nullable(),
  draftVersion: z.number().int().nullable(),
  updatedAt: Timestamp,
  /** Идущие экземпляры всех версий. */
  running: z.number().int(),
})
export type ProcessDefinitionSummary = z.infer<typeof ProcessDefinitionSummary>

export const ProcessDefinitionVersion = z.object({
  id: Uuid,
  key: z.string(),
  version: z.number().int(),
  objectType: z.string(),
  definition: ProcessDefinition,
  publishedAt: Timestamp.nullable(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ProcessDefinitionVersion = z.infer<typeof ProcessDefinitionVersion>

export const ProcessDefinitionDetails = z.object({
  key: z.string(),
  objectType: z.string(),
  name: LangText,
  published: ProcessDefinitionVersion.nullable(),
  draft: ProcessDefinitionVersion.nullable(),
  versions: z.array(
    z.object({
      id: Uuid,
      version: z.number().int(),
      publishedAt: Timestamp.nullable(),
      running: z.number().int(),
    }),
  ),
})
export type ProcessDefinitionDetails = z.infer<typeof ProcessDefinitionDetails>

/** Поле объекта для `field:<путь>` и `object.fields.<ключ>` — подсказка конструктора. */
export const ProcessFieldHint = z.object({
  path: z.string(),
  label: LangText,
  /** Тип поля карточки (`user`, `money`, `date`…), если известен. */
  type: z.string().nullable(),
})
export type ProcessFieldHint = z.infer<typeof ProcessFieldHint>

/**
 * Справочник конструктора маршрутов (ADR-0087): типы объектов с поставщиком
 * данных (поля для назначений и условий), события для шага `wait`, исполнители
 * шагов модулей (`register`, `task`, `call`).
 */
export const ProcessCatalog = z.object({
  objectTypes: z.array(
    z.object({
      type: z.string(),
      fields: z.array(ProcessFieldHint),
      /** Маршрут объекта можно запустить общим API (иначе — только модуль). */
      canStart: z.boolean(),
    }),
  ),
  waitEvents: z.array(z.string()),
  handlers: z.array(
    z.object({
      type: z.enum(['register', 'task', 'call']),
      objectType: z.string().nullable(),
      action: z.string().nullable(),
    }),
  ),
})
export type ProcessCatalog = z.infer<typeof ProcessCatalog>

/** Черновик: форма определения проверяется при сохранении, смысл — при публикации. */
export const ProcessDraftInput = z.object({ definition: z.unknown() })
export type ProcessDraftInput = z.infer<typeof ProcessDraftInput>

export const ProcessDraftSaved = z.object({
  version: ProcessDefinitionVersion,
  issues: z.array(DefinitionIssue),
})
export type ProcessDraftSaved = z.infer<typeof ProcessDraftSaved>

export const ProcessValidateInput = z.object({ definition: z.unknown() })

export const ProcessValidation = z.object({
  ok: z.boolean(),
  issues: z.array(DefinitionIssue),
})
export type ProcessValidation = z.infer<typeof ProcessValidation>

/** Предпросмотр «кто будет назначен» на примере объекта. */
export const ProcessPreviewInput = z
  .object({
    /** Проверяемое определение (черновик конструктора)… */
    definition: z.unknown().optional(),
    /** …или сохранённая версия: ключ и номер (без номера — черновик, иначе опубликованная). */
    key: z.string().optional(),
    version: z.number().int().optional(),
    objectId: Uuid,
    variables: z.record(z.string(), z.unknown()).default({}),
    assignees: z.record(z.string(), z.array(Uuid)).default({}),
  })
  .refine((input) => input.definition !== undefined || input.key !== undefined, {
    message: 'Нужно определение или ключ маршрута',
  })
export type ProcessPreviewInput = z.infer<typeof ProcessPreviewInput>

export const ProcessPreview = z.object({
  issues: z.array(DefinitionIssue),
  conditions: z.array(
    z.object({
      index: z.number().int(),
      key: z.string(),
      insertBefore: z.string(),
      matched: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  steps: z.array(
    z.object({
      key: z.string(),
      type: z.enum(STEP_TYPES),
      name: LangText.nullable(),
      /** Шаг вставлен условием запуска. */
      inserted: z.boolean(),
      assignees: z.array(z.object({ user: UserRef, source: z.string() })),
      issues: z.array(
        z.object({
          expression: z.string(),
          code: z.enum(['invalid', 'empty', 'runtime']),
          message: z.string(),
        }),
      ),
      /** Срок, если бы шаг начался сейчас. */
      dueAt: Timestamp.nullable(),
    }),
  ),
})
export type ProcessPreview = z.infer<typeof ProcessPreview>

export const ProcessStartInput = z
  .object({
    objectId: Uuid,
    definitionKey: z.string().optional(),
    definitionId: Uuid.optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    /** Выбор инициатора для шагов с `chosen_by_initiator`: ключ шага → сотрудники. */
    assignees: z.record(z.string(), z.array(Uuid).max(50)).default({}),
  })
  .refine((input) => Boolean(input.definitionKey) !== Boolean(input.definitionId), {
    message: 'Укажите ключ маршрута или идентификатор версии',
  })
export type ProcessStartInput = z.infer<typeof ProcessStartInput>

export const PROCESS_STATUSES = ['running', 'finished', 'cancelled'] as const
export const ProcessStatus = z.enum(PROCESS_STATUSES)

export const PROCESS_ACTIONS = [...DECISIONS, 'delegate', 'add_approver'] as const
export const ProcessAction = z.enum(PROCESS_ACTIONS)
export type ProcessAction = z.infer<typeof ProcessAction>

export const ProcessStepAssignee = z.object({
  user: UserRef,
  state: z.string(),
  source: z.string(),
  decidedAt: Timestamp.nullable(),
  /** Решение принял заместитель. */
  actor: UserRef.nullable(),
  addedBy: UserRef.nullable(),
  delegatedFrom: UserRef.nullable(),
  delegatedTo: UserRef.nullable(),
})

export const ProcessStepAction = z.object({
  id: Uuid,
  action: z.string(),
  actor: UserRef.nullable(),
  onBehalfOf: UserRef.nullable(),
  comment: z.string().nullable(),
  fileIds: z.array(Uuid),
  at: Timestamp,
})

export const ProcessStepView = z.object({
  id: Uuid,
  key: z.string(),
  type: z.string(),
  name: LangText.nullable(),
  status: z.enum(['active', 'completed', 'cancelled']),
  outcome: z.string().nullable(),
  round: z.number().int(),
  sequence: z.number().int(),
  parentId: Uuid.nullable(),
  branch: z.number().int().nullable(),
  activatedAt: Timestamp,
  completedAt: Timestamp.nullable(),
  dueAt: Timestamp.nullable(),
  overdue: z.boolean(),
  /** Шаг решения без назначенных: ждёт переназначения администратором. */
  unassigned: z.boolean(),
  assignees: z.array(ProcessStepAssignee),
  actions: z.array(ProcessStepAction),
  result: z.record(z.string(), z.unknown()).nullable(),
})
export type ProcessStepView = z.infer<typeof ProcessStepView>

export const ProcessMyAction = z.object({
  stepId: Uuid,
  stepKey: z.string(),
  type: z.string(),
  onBehalfOf: UserRef.nullable(),
  actions: z.array(ProcessAction),
  requireMfa: z.boolean(),
})
export type ProcessMyAction = z.infer<typeof ProcessMyAction>

export const ProcessInstanceSummary = z.object({
  id: Uuid,
  objectId: Uuid,
  definitionId: Uuid,
  definitionKey: z.string(),
  version: z.number().int(),
  name: LangText,
  status: ProcessStatus,
  outcome: z.string().nullable(),
  round: z.number().int(),
  startedBy: UserRef.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
})
export type ProcessInstanceSummary = z.infer<typeof ProcessInstanceSummary>

export const ProcessInstanceView = ProcessInstanceSummary.extend({
  /** Определение экземпляра со вставленными условиями шагами — для линии маршрута. */
  definition: ProcessDefinition,
  variables: z.record(z.string(), z.unknown()),
  steps: z.array(ProcessStepView),
  myActions: z.array(ProcessMyAction),
  canCancel: z.boolean(),
})
export type ProcessInstanceView = z.infer<typeof ProcessInstanceView>

export const ProcessActInput = z.object({
  action: z.enum(DECISIONS),
  comment: z.string().trim().max(4000).optional(),
  /** Файлы замечаний: свои файлы, прикрепляются к объекту. */
  fileIds: z.array(Uuid).max(10).default([]),
  /** Код второго фактора для подписи с подтверждением. */
  code: z.string().trim().max(16).optional(),
})
export type ProcessActInput = z.infer<typeof ProcessActInput>

export const ProcessAssigneeInput = z.object({
  userId: Uuid,
  comment: z.string().trim().max(4000).optional(),
})
export type ProcessAssigneeInput = z.infer<typeof ProcessAssigneeInput>

export const ProcessReassignInput = z.object({
  fromUserId: Uuid.nullable().default(null),
  userIds: z.array(Uuid).min(1).max(20),
})
export type ProcessReassignInput = z.infer<typeof ProcessReassignInput>

export const ProcessCancelInput = z.object({
  reason: z.string().trim().max(2000).optional(),
})
export type ProcessCancelInput = z.infer<typeof ProcessCancelInput>
