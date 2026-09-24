import { z } from 'zod'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { FieldDef } from '../fields/field-def.js'

/**
 * Формы сбора данных (06-analytics-engine.md §13, ADR-0103, ADR-0129). Форма —
 * объект реестра типа `form`, привязанный к датасету: её схема — подмножество
 * полей датасета плюс скрытые авто-поля (подразделение, период, автор, время
 * отправки). Отправка — строка датасета (у табличной формы — строки) с
 * `_import_id` отправки; контроль сдачи — матрица «подразделения × периоды».
 */

/** Ключ поля датасета. */
const FieldKey = z.string().min(1).max(160)

/** Периодичность сбора: «разово» — один период со своим сроком. */
export const FORM_PERIODICITIES = ['daily', 'weekly', 'monthly', 'once'] as const
export const FormPeriodicity = z.enum(FORM_PERIODICITIES)
export type FormPeriodicity = z.infer<typeof FormPeriodicity>

/** Время суток `ЧЧ:ММ` в поясе установки. */
export const DayTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'время в виде ЧЧ:ММ')

/**
 * Как считаются сроки (ADR-0129): по производственному календарю (`working`)
 * или календарными днями (`calendar`) — сводку дежурной службы сдают и в
 * выходные, и субботняя не должна ждать понедельника.
 */
export const FORM_DUE_MODES = ['working', 'calendar'] as const
export const FormDueMode = z.enum(FORM_DUE_MODES)
export type FormDueMode = z.infer<typeof FormDueMode>

export const FormSchedule = z.object({
  periodicity: FormPeriodicity,
  /** Час срока в поясе установки: «ежедневно к 08:00». */
  time: DayTime.default('08:00'),
  /** Рабочие дни по производственному календарю или календарные. */
  dueMode: FormDueMode.default('working'),
  /**
   * Через сколько дней после конца периода наступает срок: рабочих или
   * календарных — по `dueMode` (имя поля — от первого режима).
   */
  dueWorkingDays: z.number().int().min(0).max(30).default(1),
  /** Раньше этого дня периоды не открываются; null — со дня включения формы. */
  startsOn: DateOnly.nullable().default(null),
  /** Разовая форма: день срока. */
  dueOn: DateOnly.nullable().default(null),
})
export type FormSchedule = z.infer<typeof FormSchedule>

/** Кому сдавать: подразделение (строка матрицы) или конкретный человек. */
export const FORM_SUBJECT_KINDS = ['unit', 'user'] as const
export const FormSubjectKind = z.enum(FORM_SUBJECT_KINDS)
export type FormSubjectKind = z.infer<typeof FormSubjectKind>

export const FormSubject = z.object({ kind: FormSubjectKind, id: Uuid })
export type FormSubject = z.infer<typeof FormSubject>

/**
 * Назначение формы (ADR-0129): у подразделения можно указать ответственного за
 * сдачу — дело «Сдать сводку» уходит ему, а не главе подразделения. У
 * назначения сотруднику ответственный — он сам, поле пустое.
 */
export const FormAssignment = FormSubject.extend({
  responsibleId: Uuid.nullable().default(null),
})
export type FormAssignment = z.infer<typeof FormAssignment>

/**
 * Вид формы (ADR-0129): одна запись за период или таблица записей — список
 * происшествий за сутки, итоги которого считаются из строк.
 */
export const FORM_LAYOUTS = ['single', 'table'] as const
export const FormLayout = z.enum(FORM_LAYOUTS)
export type FormLayout = z.infer<typeof FormLayout>

/** Строк в сдаче табличной формы — не больше. */
export const FORM_TABLE_MAX_ROWS = 500

/** Сколько строк сдаёт табличная форма за период; пустая таблица — «записей не было». */
export const FormTable = z.object({
  minRows: z.number().int().min(0).max(FORM_TABLE_MAX_ROWS).default(0),
  maxRows: z.number().int().min(1).max(FORM_TABLE_MAX_ROWS).default(200),
})
export type FormTable = z.infer<typeof FormTable>

/** Поле формы — поле датасета; подпись и тип берутся из схемы датасета. */
export const FormField = z.object({
  key: FieldKey,
  required: z.boolean().default(false),
  hint: z.string().trim().max(300).nullable().default(null),
})
export type FormField = z.infer<typeof FormField>

/**
 * Скрытые авто-поля: подразделение, период, автор и время отправки
 * записываются в поля датасета сами. null — не записывать.
 */
export const FormAutoFields = z.object({
  unit: FieldKey.nullable().default(null),
  period: FieldKey.nullable().default(null),
  author: FieldKey.nullable().default(null),
  submittedAt: FieldKey.nullable().default(null),
})
export type FormAutoFields = z.infer<typeof FormAutoFields>

/** Приёмка ответственным: принять или вернуть с комментарием. */
export const FormReview = z.object({
  enabled: z.boolean().default(false),
  /** Язык назначений маршрутов (`user:`, `role:`, `unit_head(…)`), ADR-0079. */
  reviewers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
})
export type FormReview = z.infer<typeof FormReview>

/** Просрочка: эскалация руководителю назначенного, как у поручений. */
export const FormEscalation = z.object({
  enabled: z.boolean().default(true),
  afterWorkingDays: z.number().int().min(0).max(30).default(1),
})
export type FormEscalation = z.infer<typeof FormEscalation>

export const FormDefinition = z.object({
  datasetId: Uuid,
  /** Одна запись за период или таблица; у табличной поля формы — столбцы. */
  layout: FormLayout.default('single'),
  /** Границы числа строк — только у табличной формы. */
  table: FormTable.prefault({}),
  fields: z.array(FormField).min(1).max(100),
  auto: FormAutoFields.prefault({}),
  schedule: FormSchedule,
  assignments: z.array(FormAssignment).max(300).default([]),
  review: FormReview.prefault({}),
  escalation: FormEscalation.prefault({}),
})
export type FormDefinition = z.infer<typeof FormDefinition>

const Name = z.string().trim().min(1).max(200)
const Description = z.string().trim().max(1000)

export const FormRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  datasetId: Uuid,
  datasetName: z.string().nullable(),
  definition: FormDefinition,
  enabled: z.boolean(),
  /** Служебная учётная запись, от имени которой пишутся строки (ADR-0130). */
  runAs: Uuid.nullable(),
  /** Право менять форму и принимать отправки. */
  canManage: z.boolean(),
  /** Смотрящий — назначенный: ему открыт экран заполнения. */
  canSubmit: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type FormRecord = z.infer<typeof FormRecord>

export const FormListItem = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  datasetId: Uuid,
  datasetName: z.string().nullable(),
  periodicity: FormPeriodicity,
  enabled: z.boolean(),
  assignments: z.number().int().nonnegative(),
  /** Отправок с наступившим сроком и не сданных. */
  overdue: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type FormListItem = z.infer<typeof FormListItem>

export const FormList = z.object({ items: z.array(FormListItem) })
export type FormList = z.infer<typeof FormList>

export const FormListQuery = z.object({
  spaceId: Uuid.optional(),
  datasetId: Uuid.optional(),
  /** Только формы, назначенные смотрящему. */
  mine: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type FormListQuery = z.infer<typeof FormListQuery>

export const FormCreateInput = z.object({
  name: Name,
  description: Description.nullish(),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  definition: FormDefinition,
  /**
   * Служебная учётная запись, от имени которой форма пишет строки датасета
   * (ADR-0130): без неё форму можно настроить, но не включить.
   */
  runAs: Uuid.nullable().default(null),
  enabled: z.boolean().default(false),
})
export type FormCreateInput = z.infer<typeof FormCreateInput>

export const FormUpdateInput = z
  .object({
    name: Name,
    description: Description.nullable(),
    definition: FormDefinition,
    runAs: Uuid.nullable(),
  })
  .partial()
export type FormUpdateInput = z.infer<typeof FormUpdateInput>

export const FormEnabledInput = z.object({ enabled: z.boolean() })
export type FormEnabledInput = z.infer<typeof FormEnabledInput>

/** Черновик → сдано → принято; возвращено — снова у назначенного. */
export const FORM_SUBMISSION_STATUSES = ['draft', 'submitted', 'accepted', 'returned'] as const
export const FormSubmissionStatus = z.enum(FORM_SUBMISSION_STATUSES)
export type FormSubmissionStatus = z.infer<typeof FormSubmissionStatus>

export const FormSubmission = z.object({
  id: Uuid,
  formId: Uuid,
  formName: z.string(),
  /** Ключ периода: `2026-09-19`, `2026-W38`, `2026-09`, `once`. */
  periodKey: z.string(),
  periodStart: DateOnly,
  periodEnd: DateOnly,
  dueAt: Timestamp.nullable(),
  subject: FormSubject,
  subjectName: z.string().nullable(),
  status: FormSubmissionStatus,
  values: z.record(z.string(), z.unknown()),
  /** Табличная форма: строки сводки, как их сохранили или сдали; у одиночной — null. */
  rows: z.array(z.record(z.string(), z.unknown())).nullable(),
  /** Строка датасета, созданная отправкой. */
  rowId: z.string().nullable(),
  /** Строки датасета, записанные сдачей: у одиночной формы — одна. */
  rowIds: z.array(z.string()),
  authorId: Uuid.nullable(),
  submittedAt: Timestamp.nullable(),
  reviewerId: Uuid.nullable(),
  reviewedAt: Timestamp.nullable(),
  comment: z.string().nullable(),
  /** Смотрящий заполняет и сдаёт эту отправку. */
  canSubmit: z.boolean(),
  /** Смотрящий принимает и возвращает эту отправку. */
  canReview: z.boolean(),
  updatedAt: Timestamp,
})
export type FormSubmission = z.infer<typeof FormSubmission>

export const FormSubmissionOpenInput = z.object({
  periodKey: z.string().trim().min(1).max(32),
  subject: FormSubject,
})
export type FormSubmissionOpenInput = z.infer<typeof FormSubmissionOpenInput>

/**
 * Значения сводки: у одиночной формы — `values`, у табличной — `rows` (пустой
 * массив — «записей не было»). Вид проверяет сервер по определению формы.
 */
export const FormSubmissionSaveInput = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  rows: z.array(z.record(z.string(), z.unknown())).max(FORM_TABLE_MAX_ROWS).optional(),
})
export type FormSubmissionSaveInput = z.infer<typeof FormSubmissionSaveInput>

export const FormReviewInput = z.object({
  decision: z.enum(['accept', 'return']),
  comment: z.string().trim().max(2000).nullish(),
})
export type FormReviewInput = z.infer<typeof FormReviewInput>

/** Ячейка матрицы контроля: `missing` — период открыт, отправки ещё нет. */
export const FORM_CELL_STATES = ['missing', 'draft', 'submitted', 'accepted', 'returned'] as const
export const FormCellState = z.enum(FORM_CELL_STATES)
export type FormCellState = z.infer<typeof FormCellState>

export const FormControlCell = z.object({
  periodKey: z.string(),
  state: FormCellState,
  submissionId: Uuid.nullable(),
  overdue: z.boolean(),
  /** Табличная форма: сколько строк сдано; у одиночной и несданной — null. */
  rows: z.number().int().nonnegative().nullable(),
})
export type FormControlCell = z.infer<typeof FormControlCell>

export const FormControlRow = z.object({
  subject: FormSubject,
  name: z.string(),
  cells: z.array(FormControlCell),
})
export type FormControlRow = z.infer<typeof FormControlRow>

export const FormControlPeriod = z.object({
  key: z.string(),
  start: DateOnly,
  end: DateOnly,
  dueAt: Timestamp.nullable(),
})
export type FormControlPeriod = z.infer<typeof FormControlPeriod>

export const FormControl = z.object({
  formId: Uuid,
  periods: z.array(FormControlPeriod),
  rows: z.array(FormControlRow),
  totals: z.object({
    expected: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
  }),
})
export type FormControl = z.infer<typeof FormControl>

export const FormControlQuery = z.object({
  /** Сколько последних периодов показать. */
  periods: z.coerce.number().int().min(1).max(24).default(8),
  /** Оставить только строки, где есть ячейка в этом состоянии. */
  state: FormCellState.optional(),
})
export type FormControlQuery = z.infer<typeof FormControlQuery>

/**
 * Схема экрана заполнения: поля датасета формы в виде полей `SchemaForm`
 * ядра полей — подписи, типы, справочники и обязательность уже применены.
 */
export const FormSchema = z.object({
  formId: Uuid,
  fields: z.array(FieldDef),
})
export type FormSchema = z.infer<typeof FormSchema>

/** Период формы для выбора на экране заполнения. */
export const FormPeriodOption = z.object({
  key: z.string(),
  start: DateOnly,
  end: DateOnly,
  dueAt: Timestamp.nullable(),
  state: FormCellState,
  submissionId: Uuid.nullable(),
})
export type FormPeriodOption = z.infer<typeof FormPeriodOption>

/** Что предстоит сдать смотрящему: форма, период и его отправка. */
export const FormDuty = z.object({
  formId: Uuid,
  formName: z.string(),
  subject: FormSubject,
  subjectName: z.string().nullable(),
  periods: z.array(FormPeriodOption),
})
export type FormDuty = z.infer<typeof FormDuty>

export const FormDutyList = z.object({ items: z.array(FormDuty) })
export type FormDutyList = z.infer<typeof FormDutyList>
