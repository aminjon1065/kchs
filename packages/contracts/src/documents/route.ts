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

/** Файл в манифесте версии: закреплённая версия и её SHA-256 (ADR-0198). */
export const DocumentManifestFile = z.object({
  fileId: Uuid,
  fileVersionId: Uuid.nullable(),
  sha256: z.string(),
})
export type DocumentManifestFile = z.infer<typeof DocumentManifestFile>

/**
 * Манифест версии документа (ADR-0198): что именно фиксирует подпись — основной
 * файл, приложения и PDF-представление, каждый своей версией и хэшем. Хэш подписи —
 * SHA-256 канонического JSON манифеста (ключи по алфавиту, без пробелов, UTF-8).
 */
export const DocumentManifest = z.object({
  v: z.literal(1),
  documentId: Uuid,
  versionNumber: z.number().int(),
  mainFile: DocumentManifestFile,
  attachments: z.array(DocumentManifestFile),
  pdf: DocumentManifestFile.nullable(),
})
export type DocumentManifest = z.infer<typeof DocumentManifest>

/** Откуда место факсимиле на листе: выбрал человек, маркер бланка, фамилия, по умолчанию. */
export const SIGNATURE_PLACEMENT_SOURCES = ['manual', 'marker', 'name', 'fallback'] as const
export const SignaturePlacementSource = z.enum(SIGNATURE_PLACEMENT_SOURCES)
export type SignaturePlacementSource = z.infer<typeof SignaturePlacementSource>

/** Центр факсимиле на листе: лист с 1, доли ширины и высоты от левого верхнего угла. */
export const SignaturePlacement = z.object({
  page: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  source: SignaturePlacementSource,
})
export type SignaturePlacement = z.infer<typeof SignaturePlacement>

/** Правка места факсимиле человеком (ADR-0198): экземпляр строится заново. */
export const SignaturePlacementInput = SignaturePlacement.omit({ source: true })
export type SignaturePlacementInput = z.infer<typeof SignaturePlacementInput>

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
  /**
   * SHA-256 манифеста подписанной версии (ADR-0198); у подписей до манифеста —
   * SHA-256 основного файла.
   */
  hash: z.string().nullable(),
  kind: z.enum(['simple', 'qualified']),
  /** Подтверждено вторым фактором. */
  mfa: z.boolean(),
  state: DocumentSignatureState,
  /** Подписана текущая версия документа. */
  current: z.boolean(),
  /** Что зафиксировала подпись: файлы версии и их хэши; null — подпись до манифеста. */
  manifest: DocumentManifest.nullable().optional(),
  /** На подписанном экземпляре стоит факсимиле того, кто подписал. */
  facsimile: z.boolean().optional(),
  /** Где стоит факсимиле на подписанном экземпляре. */
  placement: SignaturePlacement.nullable().optional(),
  /** Может ли смотрящий поправить место факсимиле. */
  canPlace: z.boolean().optional(),
})
export type DocumentSignature = z.infer<typeof DocumentSignature>

export const DocumentSignatureList = z.object({ items: z.array(DocumentSignature) })
export type DocumentSignatureList = z.infer<typeof DocumentSignatureList>
