import { z } from 'zod'
import { LangText, Timestamp, Uuid } from '../common/primitives.js'
import { DocumentCreateInput, DocumentFileRef } from './document.js'

/**
 * Шаблоны DOCX (08-documents.md §8, ADR-0085): файл с плейсхолдерами Jinja
 * (docxtpl) — `{{ doc.subject }}`, `{{ doc.fields.addressee }}`,
 * `{{ author.position }}`, циклы и строки таблиц `{%tr for a in doc.attachments %}`.
 * Контекст заполнения — только эти пути: движок исполняет шаблон в песочнице.
 */

/** Сведения о сотруднике в контексте: автор, подписант, ответственный, контролёр. */
export const TEMPLATE_PERSON_KEYS = [
  'name',
  'short_name',
  'last_name',
  'position',
  'unit',
  'email',
  'phone',
] as const
export const TEMPLATE_PEOPLE = ['author', 'signer', 'responsible', 'controller'] as const

/** Реквизиты документа (`doc.*`); поля карточки типа — `doc.fields.<ключ>`. */
export const TEMPLATE_DOC_KEYS = [
  'subject',
  'summary',
  'type',
  'reg_number',
  'reg_date',
  'deadline',
  'external_number',
  'external_date',
  'received_date',
  'delivery_method',
  'unit',
  'correspondent.name',
  'correspondent.short_name',
  'correspondent.address',
  'correspondent.head',
  'correspondent.email',
  'correspondent.phone',
] as const

/** Списки для циклов и строк таблиц: путь → поля элемента. */
export const TEMPLATE_LISTS = {
  'doc.attachments': ['name'],
} as const satisfies Record<string, readonly string[]>

export const TEMPLATE_GLOBALS = ['org.name', 'today'] as const

/** Все известные плейсхолдеры, кроме полей карточки. */
export function templatePlaceholders(): string[] {
  return [
    ...TEMPLATE_DOC_KEYS.map((key) => `doc.${key}`),
    ...Object.keys(TEMPLATE_LISTS),
    ...TEMPLATE_PEOPLE.flatMap((person) => TEMPLATE_PERSON_KEYS.map((key) => `${person}.${key}`)),
    ...TEMPLATE_GLOBALS,
  ]
}

const FIELD_PATH = /^doc\.fields\.([a-z][a-z0-9_]*)$/

/**
 * Разбор плейсхолдеров шаблона: известные и неизвестные. Поле карточки
 * известно, если оно есть у типа шаблона; без типа — любое по форме ключа.
 * Путь элемента цикла движок не присылает: переменная цикла объявлена в шаблоне.
 */
export function classifyPlaceholders(
  found: readonly string[],
  fieldKeys: readonly string[] | null,
): { known: string[]; unknown: string[] } {
  const known = new Set(templatePlaceholders())
  const fields = fieldKeys ? new Set(fieldKeys) : null
  const result = { known: [] as string[], unknown: [] as string[] }
  for (const path of [...new Set(found)].sort()) {
    const field = FIELD_PATH.exec(path)
    const ok = known.has(path) || (field ? (fields ? fields.has(field[1] ?? '') : true) : false)
    if (ok) result.known.push(path)
    else result.unknown.push(path)
  }
  return result
}

export const TEMPLATE_INSPECT_STATUSES = ['none', 'pending', 'ready', 'failed'] as const
export const TemplateInspectStatus = z.enum(TEMPLATE_INSPECT_STATUSES)
export type TemplateInspectStatus = z.infer<typeof TemplateInspectStatus>

/** Карточка по умолчанию документа, созданного по шаблону. */
export const TemplateDefaults = z.object({
  subject: z.string().trim().max(1000).optional(),
  summary: z.string().trim().max(20_000).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
})
export type TemplateDefaults = z.infer<typeof TemplateDefaults>

export const DocumentTemplateRecord = z.object({
  id: Uuid,
  /** Пространство шаблона: файл шаблона загружается вложением в него. */
  spaceId: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  type: z.object({ id: Uuid, key: z.string(), name: LangText }).nullable(),
  file: DocumentFileRef.nullable(),
  defaults: TemplateDefaults,
  /** Найденные плейсхолдеры — по разбору движком. */
  placeholders: z.array(z.string()),
  /** Плейсхолдеры, которых нет в контексте: при заполнении будут пустыми. */
  unknownPlaceholders: z.array(z.string()),
  inspectStatus: TemplateInspectStatus,
  inspectError: z.string().nullable(),
  isActive: z.boolean(),
  canManage: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type DocumentTemplateRecord = z.infer<typeof DocumentTemplateRecord>

export const DocumentTemplateList = z.object({ items: z.array(DocumentTemplateRecord) })
export type DocumentTemplateList = z.infer<typeof DocumentTemplateList>

export const DocumentTemplateCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().default(null),
  typeId: Uuid.nullable().default(null),
  defaults: TemplateDefaults.default({}),
})
export type DocumentTemplateCreateInput = z.infer<typeof DocumentTemplateCreateInput>

export const DocumentTemplateUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  typeId: Uuid.nullable().optional(),
  defaults: TemplateDefaults.optional(),
  isActive: z.boolean().optional(),
})
export type DocumentTemplateUpdateInput = z.infer<typeof DocumentTemplateUpdateInput>

/** Файл шаблона: DOCX, уже загруженный вложением шаблона. */
export const DocumentTemplateFileInput = z.object({ fileId: Uuid })
export type DocumentTemplateFileInput = z.infer<typeof DocumentTemplateFileInput>

export const DocumentTemplateListQuery = z.object({
  typeId: Uuid.optional(),
  includeInactive: z.coerce.boolean().default(false),
})
export type DocumentTemplateListQuery = z.infer<typeof DocumentTemplateListQuery>

/**
 * «Создать по шаблону»: черновик с карточкой шаблона и введённой, файл
 * первой версии строит движок. Тип — из запроса или из шаблона.
 */
export const DocumentFromTemplateInput = DocumentCreateInput.partial({ typeId: true }).extend({
  templateId: Uuid,
})
export type DocumentFromTemplateInput = z.infer<typeof DocumentFromTemplateInput>

export const DocumentFromTemplateResult = z.object({ id: Uuid, renderId: Uuid })
export type DocumentFromTemplateResult = z.infer<typeof DocumentFromTemplateResult>

/** Перезаполнить по шаблону из текущей карточки — новая версия документа. */
export const DocumentFillInput = z.object({ templateId: Uuid })
export type DocumentFillInput = z.infer<typeof DocumentFillInput>
