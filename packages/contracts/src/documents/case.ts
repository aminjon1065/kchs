import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Дело номенклатуры (08-documents.md §12, ADR-0086): открыто — в него
 * подшивают исполненные документы; закрыто — по окончании года; в архиве —
 * передано вместе с документами; уничтожено — по акту о выделении к
 * уничтожению: файлы документов удалены, карточки остались описью.
 */
export const CASE_STATUSES = ['open', 'closed', 'archived', 'destroyed'] as const
export const CaseStatus = z.enum(CASE_STATUSES)
export type CaseStatus = z.infer<typeof CaseStatus>

/** Короткая ссылка на дело — для карточки документа и списков. */
export const CaseRef = z.object({
  id: Uuid,
  index: z.string(),
  title: z.string(),
  year: z.number().int(),
  status: CaseStatus,
})
export type CaseRef = z.infer<typeof CaseRef>

export const CaseUnitRef = z.object({ id: Uuid, name: z.string() })
export type CaseUnitRef = z.infer<typeof CaseUnitRef>

/** Акт о выделении к уничтожению — кратко, для карточки дела. */
export const DestructionActRef = z.object({
  id: Uuid,
  number: z.string(),
  actDate: DateOnly,
})
export type DestructionActRef = z.infer<typeof DestructionActRef>

export const CaseRecord = z.object({
  id: Uuid,
  /** Индекс по номенклатуре: «01-05». Уникален в пределах года. */
  index: z.string(),
  title: z.string(),
  year: z.number().int(),
  unit: CaseUnitRef.nullable(),
  /** Срок хранения, лет; null — постоянно. */
  retentionYears: z.number().int().nullable(),
  /** Статья перечня, отметка ЭПК и прочее — как в номенклатуре. */
  retentionNote: z.string().nullable(),
  /** Типы документов, для которых дело предлагается при подшивке. */
  documentTypeIds: z.array(Uuid),
  status: CaseStatus,
  note: z.string().nullable(),
  documentCount: z.number().int(),
  /**
   * С какого дня дело можно выделить к уничтожению: 1 января года, следующего
   * за годом дела, плюс срок хранения. Null — хранится постоянно.
   */
  destroyableFrom: DateOnly.nullable(),
  closedAt: Timestamp.nullable(),
  closedBy: UserRef.nullable(),
  archivedAt: Timestamp.nullable(),
  archivedBy: UserRef.nullable(),
  destroyedAt: Timestamp.nullable(),
  destructionAct: DestructionActRef.nullable(),
  /** Вести дело: правка, закрытие, передача в архив (канцелярия). */
  canManage: z.boolean(),
  /** Подшивать документы в дело — делопроизводитель, пока дело открыто. */
  canFile: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type CaseRecord = z.infer<typeof CaseRecord>

export const CaseList = z.object({ items: z.array(CaseRecord) })
export type CaseList = z.infer<typeof CaseList>

export const CaseListQuery = z.object({
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  status: CaseStatus.optional(),
  unitId: Uuid.optional(),
  q: z.string().trim().max(200).optional(),
})
export type CaseListQuery = z.infer<typeof CaseListQuery>

const Index = z.string().trim().min(1).max(40)
const Title = z.string().trim().min(1).max(500)
const Year = z.number().int().min(1900).max(2100)
const RetentionYears = z.number().int().min(1).max(100).nullable()
const RetentionNote = z.string().trim().max(500).nullable()
const Note = z.string().trim().max(2000).nullable()

export const CaseCreateInput = z.object({
  index: Index,
  title: Title,
  year: Year,
  unitId: Uuid.nullable().default(null),
  retentionYears: RetentionYears.default(null),
  retentionNote: RetentionNote.default(null),
  documentTypeIds: z.array(Uuid).max(50).default([]),
  note: Note.default(null),
})
export type CaseCreateInput = z.infer<typeof CaseCreateInput>

/** Индекс и год меняются, пока в деле нет документов. */
export const CaseUpdateInput = z.object({
  index: Index.optional(),
  title: Title.optional(),
  year: Year.optional(),
  unitId: Uuid.nullable().optional(),
  retentionYears: RetentionYears.optional(),
  retentionNote: RetentionNote.optional(),
  documentTypeIds: z.array(Uuid).max(50).optional(),
  note: Note.optional(),
})
export type CaseUpdateInput = z.infer<typeof CaseUpdateInput>

/** Закрыть все открытые дела года (конец делопроизводственного года). */
export const CaseCloseYearInput = z.object({ year: Year })
export type CaseCloseYearInput = z.infer<typeof CaseCloseYearInput>

/** Подшить исполненный документ в открытое дело. */
export const DocumentFileInput = z.object({ caseId: Uuid })
export type DocumentFileInput = z.infer<typeof DocumentFileInput>

/** Насколько дело подходит документу: по типу и подразделению. */
export const CASE_MATCHES = ['type_unit', 'type', 'unit', 'other'] as const
export const CaseMatch = z.enum(CASE_MATCHES)
export type CaseMatch = z.infer<typeof CaseMatch>

export const CaseSuggestion = CaseRef.extend({
  unitName: z.string().nullable(),
  match: CaseMatch,
})
export type CaseSuggestion = z.infer<typeof CaseSuggestion>

/** Для чего подбирается дело: подшивка (любой год) или номер при регистрации (год регистрации). */
export const CaseSuggestionsQuery = z.object({
  purpose: z.enum(['filing', 'registration']).default('filing'),
})
export type CaseSuggestionsQuery = z.infer<typeof CaseSuggestionsQuery>

/** Открытые дела для подшивки: сначала подходящие по типу и подразделению. */
export const CaseSuggestions = z.object({
  items: z.array(CaseSuggestion),
  /** Предлагаемое дело — единственное лучшее совпадение. */
  suggestedId: Uuid.nullable(),
})
export type CaseSuggestions = z.infer<typeof CaseSuggestions>

/**
 * Акт о выделении к уничтожению (08-documents.md §12): дела в архиве с
 * истёкшим сроком хранения; файлы документов удаляются, карточки остаются.
 */
export const DestructionActInput = z.object({
  caseIds: z.array(Uuid).min(1).max(200),
  /** Основание: протокол экспертной комиссии и т. п. */
  basis: z.string().trim().min(10).max(2000),
})
export type DestructionActInput = z.infer<typeof DestructionActInput>

export const DestructionActRecord = z.object({
  id: Uuid,
  number: z.string(),
  actDate: DateOnly,
  basis: z.string(),
  cases: z.array(CaseRef),
  documentCount: z.number().int(),
  fileCount: z.number().int(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type DestructionActRecord = z.infer<typeof DestructionActRecord>

export const DestructionActList = z.object({ items: z.array(DestructionActRecord) })
export type DestructionActList = z.infer<typeof DestructionActList>

/**
 * День, с которого дело можно выделить к уничтожению: срок хранения
 * исчисляется с 1 января года, следующего за годом дела. Null — постоянно.
 */
export function caseDestroyableFrom(year: number, retentionYears: number | null): string | null {
  if (retentionYears === null) return null
  return `${String(year + 1 + retentionYears).padStart(4, '0')}-01-01`
}
