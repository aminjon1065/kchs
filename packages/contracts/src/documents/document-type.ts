import { z } from 'zod'
import { Confidentiality } from '../access/confidentiality.js'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'
import { FieldDef } from '../fields/field-def.js'

/** Направление документа (08-documents.md §2). */
export const DOCUMENT_DIRECTIONS = ['incoming', 'outgoing', 'internal'] as const
export const DocumentDirection = z.enum(DOCUMENT_DIRECTIONS)
export type DocumentDirection = z.infer<typeof DocumentDirection>

/**
 * Кому направлять документ на резолюцию после регистрации (ADR-0084):
 * `unit_head` — руководителю подразделения документа (без него — ближайшему
 * вышестоящему), `user` — выбранному сотруднику, `none` — вручную.
 */
export const RESOLUTION_ROUTES = ['none', 'unit_head', 'user'] as const
export const ResolutionRoute = z.enum(RESOLUTION_ROUTES)
export type ResolutionRoute = z.infer<typeof ResolutionRoute>

/**
 * Правила типа (08-documents.md §2): обязателен скан, разрешены резолюции,
 * ознакомление при регистрации, автоконтроль сроков; направление на резолюцию
 * и ознакомление (ADR-0084).
 */
export const DocumentTypeSettings = z.object({
  requireScan: z.boolean().default(false),
  allowResolutions: z.boolean().default(true),
  ackOnRegister: z.boolean().default(false),
  /** Документ с установленным сроком при регистрации ставится на контроль. */
  autoControl: z.boolean().default(false),
  /** Срок по умолчанию — через N рабочих дней от регистрации (null — не задаётся). */
  defaultDeadlineDays: z.number().int().min(1).max(365).nullable().default(null),
  /** Направление на резолюцию после регистрации. */
  resolutionBy: ResolutionRoute.default('none'),
  /** Получатель направления при `resolutionBy: user`. */
  resolutionUserId: Uuid.nullable().default(null),
  /** Кого знакомить при регистрации: подразделения; пусто — подразделение документа. */
  ackUnitIds: z.array(Uuid).max(20).default([]),
  /** Срок ознакомления в рабочих днях от запроса (null — без срока). */
  ackDueWorkingDays: z.number().int().min(1).max(60).nullable().default(null),
  /** Отметка об ознакомлении подтверждается кодом второго фактора. */
  ackRequireMfa: z.boolean().default(false),
})
export type DocumentTypeSettings = z.infer<typeof DocumentTypeSettings>

/** Нумерация типа: журнал регистрации по умолчанию и, при необходимости, свой шаблон. */
export const DocumentNumbering = z.object({
  journalId: Uuid.nullable().default(null),
  /** Шаблон номера вместо шаблона журнала (редко: отдельная серия в общем журнале). */
  format: z.string().max(64).nullable().default(null),
})
export type DocumentNumbering = z.infer<typeof DocumentNumbering>

/** Схема карточки типа — поля системы типов (contracts/field-types.md). */
export const DocumentCardSchema = z.object({
  fields: z.array(FieldDef).max(60).default([]),
})
export type DocumentCardSchema = z.infer<typeof DocumentCardSchema>

export const DocumentTypeKey = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'ключ типа: строчные латинские буквы, цифры и _')

export const DocumentTypeRecord = z.object({
  id: Uuid,
  key: z.string(),
  name: LangText,
  direction: DocumentDirection,
  cardSchema: DocumentCardSchema,
  numbering: DocumentNumbering,
  /** Ключ маршрута по умолчанию (определение процесса) — подключает вторая волна. */
  defaultRouteKey: z.string().nullable(),
  retentionYears: z.number().int().nullable(),
  confidentialityAllowed: z.array(Confidentiality).min(1),
  defaultConfidentiality: Confidentiality,
  /** Печатные формы типа — ключи шаблонов (регистрационная карточка, штамп…). */
  printForms: z.array(z.string()),
  settings: DocumentTypeSettings,
  isActive: z.boolean(),
  /** Журнал по умолчанию — название для карточки типа. */
  journalName: z.string().nullable(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type DocumentTypeRecord = z.infer<typeof DocumentTypeRecord>

export const DocumentTypeCreateInput = z.object({
  key: DocumentTypeKey,
  name: LangText,
  direction: DocumentDirection,
  cardSchema: DocumentCardSchema.default({ fields: [] }),
  numbering: DocumentNumbering.default({ journalId: null, format: null }),
  defaultRouteKey: z.string().max(120).nullable().default(null),
  retentionYears: z.number().int().min(0).max(100).nullable().default(null),
  confidentialityAllowed: z
    .array(Confidentiality)
    .min(1)
    .default(['public', 'internal', 'confidential']),
  defaultConfidentiality: Confidentiality.default('internal'),
  printForms: z.array(z.string().max(64)).max(20).default([]),
  settings: DocumentTypeSettings.default({
    requireScan: false,
    allowResolutions: true,
    ackOnRegister: false,
    autoControl: false,
    defaultDeadlineDays: null,
    resolutionBy: 'none',
    resolutionUserId: null,
    ackUnitIds: [],
    ackDueWorkingDays: null,
    ackRequireMfa: false,
  }),
})
export type DocumentTypeCreateInput = z.infer<typeof DocumentTypeCreateInput>

/** Базовая правка типа: всё, кроме ключа и направления. */
export const DocumentTypeUpdateInput = z.object({
  name: LangText.optional(),
  cardSchema: DocumentCardSchema.optional(),
  numbering: DocumentNumbering.optional(),
  defaultRouteKey: z.string().max(120).nullable().optional(),
  retentionYears: z.number().int().min(0).max(100).nullable().optional(),
  confidentialityAllowed: z.array(Confidentiality).min(1).optional(),
  defaultConfidentiality: Confidentiality.optional(),
  printForms: z.array(z.string().max(64)).max(20).optional(),
  settings: DocumentTypeSettings.partial().optional(),
  isActive: z.boolean().optional(),
})
export type DocumentTypeUpdateInput = z.infer<typeof DocumentTypeUpdateInput>
