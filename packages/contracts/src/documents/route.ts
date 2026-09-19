import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Маршруты документа (08-documents.md §4, §9, ADR-0083): опубликованные
 * определения движка процессов для типа объекта `document`, запуск из карточки,
 * текущие шаги в шапке, простая электронная подпись. Линию шагов и действия
 * шага отдаёт общее API движка (`/processes`, ADR-0079).
 */

/** Переменная маршрута, которую задаёт инициатор при запуске (`var:signer`). */
export const DocumentRouteVariable = z.object({
  name: z.string(),
  /** Тип переменной движка: user, users, unit, group, text, number, date, boolean. */
  type: z.string(),
  label: LangText,
  description: LangText.nullable(),
  required: z.boolean(),
})
export type DocumentRouteVariable = z.infer<typeof DocumentRouteVariable>

/** Шаг, исполнителей которого выбирает инициатор (`chosen_by_initiator`). */
export const DocumentRouteChoice = z.object({
  stepKey: z.string(),
  type: z.string(),
  name: LangText.nullable(),
  /** Выбор — единственное назначение шага: без него маршрут не запустится. */
  required: z.boolean(),
})
export type DocumentRouteChoice = z.infer<typeof DocumentRouteChoice>

export const DocumentRouteOption = z.object({
  key: z.string(),
  version: z.number().int(),
  name: LangText,
  description: LangText.nullable(),
  /** Маршрут типа документа по умолчанию (`defaultRouteKey`). */
  isDefault: z.boolean(),
  variables: z.array(DocumentRouteVariable),
  choices: z.array(DocumentRouteChoice),
})
export type DocumentRouteOption = z.infer<typeof DocumentRouteOption>

/** Почему маршрут сейчас не запустить. */
export const DOCUMENT_ROUTE_BLOCKERS = ['access', 'status', 'running', 'no_version'] as const
export const DocumentRouteBlocker = z.enum(DOCUMENT_ROUTE_BLOCKERS)
export type DocumentRouteBlocker = z.infer<typeof DocumentRouteBlocker>

export const DocumentRouteOptions = z.object({
  canStart: z.boolean(),
  blocker: DocumentRouteBlocker.nullable(),
  items: z.array(DocumentRouteOption),
})
export type DocumentRouteOptions = z.infer<typeof DocumentRouteOptions>

/** Запуск маршрута и предпросмотр назначений: маршрут, переменные, выбор инициатора. */
export const DocumentRouteStartInput = z.object({
  definitionKey: z.string().min(1).max(64),
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Ключ шага → выбранные сотрудники. */
  assignees: z.record(z.string(), z.array(Uuid).max(50)).default({}),
})
export type DocumentRouteStartInput = z.infer<typeof DocumentRouteStartInput>

/** Текущий шаг идущего маршрута — для шапки карточки и списка. */
export const DocumentRouteStep = z.object({
  id: Uuid,
  key: z.string(),
  type: z.string(),
  name: LangText.nullable(),
  dueAt: Timestamp.nullable(),
  overdue: z.boolean(),
  /** Ждут решения (очередь последовательного шага — только первый). */
  pending: z.array(UserRef),
})
export type DocumentRouteStep = z.infer<typeof DocumentRouteStep>

export const DocumentRouteBrief = z.object({
  instanceId: Uuid,
  definitionKey: z.string(),
  name: LangText,
  round: z.number().int(),
  steps: z.array(DocumentRouteStep),
})
export type DocumentRouteBrief = z.infer<typeof DocumentRouteBrief>

/** Какую версию видел шаг согласования или подписи (заморозка при активации). */
export const DocumentRouteStepVersion = z.object({
  stepId: Uuid,
  versionId: Uuid,
  versionNumber: z.number().int(),
})
export type DocumentRouteStepVersion = z.infer<typeof DocumentRouteStepVersion>

export const DocumentRouteStepVersions = z.object({ items: z.array(DocumentRouteStepVersion) })
export type DocumentRouteStepVersions = z.infer<typeof DocumentRouteStepVersions>

/**
 * Состояние подписи: хэш подписанной версии совпадает с хэшем версии
 * (`valid`), хэш ещё считает движок (`pending`) или разошёлся (`mismatch`).
 */
export const DOCUMENT_SIGNATURE_STATES = ['valid', 'pending', 'mismatch'] as const
export const DocumentSignatureState = z.enum(DOCUMENT_SIGNATURE_STATES)
export type DocumentSignatureState = z.infer<typeof DocumentSignatureState>

/** Простая электронная подпись (08-documents.md §9). */
export const DocumentSignature = z.object({
  id: Uuid,
  versionId: Uuid.nullable(),
  versionNumber: z.number().int().nullable(),
  /** Подписант — чья очередь на шаге подписи. */
  signer: UserRef,
  /** Кто нажал «Подписать», если не сам подписант (заместитель). */
  actor: UserRef.nullable(),
  signedAt: Timestamp,
  /** SHA-256 основного файла подписанной версии. */
  hash: z.string().nullable(),
  kind: z.enum(['simple', 'qualified']),
  /** Подтверждено вторым фактором. */
  mfa: z.boolean(),
  state: DocumentSignatureState,
  /** Подписана текущая версия документа. */
  current: z.boolean(),
})
export type DocumentSignature = z.infer<typeof DocumentSignature>

export const DocumentSignatureList = z.object({ items: z.array(DocumentSignature) })
export type DocumentSignatureList = z.infer<typeof DocumentSignatureList>
