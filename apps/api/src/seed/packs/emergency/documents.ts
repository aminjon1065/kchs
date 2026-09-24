import type { DocumentTypeCreateInput, FieldDef } from '@kchs/contracts'
import type { ProcessDefinitionInput } from '@kchs/process'
import { eq } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { ProcessDefinitions } from '~/kernel/process/index.js'
import { JournalService } from '~/modules/documents/domain/journal-service.js'
import { DocumentTypeService } from '~/modules/documents/domain/type-service.js'
import { db } from '~/shared/db/client.js'
import { documentTypes, journals } from '~/shared/db/schema/index.js'
import { type PackContext, unitId } from './context.js'
import { INCIDENT_KINDS } from './datasets.js'

/**
 * Документы штаба (04-domain-pack-emergency.md «Документы и процессы»): донесение о ЧС
 * с реквизитами происшествия, распоряжение и протокол штаба, оперативная сводка в
 * Правительство; экстренные маршруты — со сроками в часах (ADR-0131), без привязки к
 * кодам подразделений: согласующих выбирает инициатор, подписанта — карточка.
 */

const cardField = (
  key: string,
  ru: string,
  en: string,
  type: FieldDef['type'],
  extra: Partial<FieldDef> = {},
): FieldDef =>
  ({
    key,
    label: { ru, en },
    type,
    semantic: type === 'territory' ? 'territory' : 'dimension',
    required: false,
    unique: false,
    indexed: false,
    sensitive: false,
    readOnly: false,
    nullable: true,
    order: 0,
    ...extra,
  }) as FieldDef

/** Реквизиты донесения о ЧС: по ним правила отбирают тяжёлые происшествия. */
export const REPORT_FIELDS: FieldDef[] = [
  cardField('incident_kind', 'Вид ЧС', 'Emergency kind', 'select', {
    required: true,
    options: INCIDENT_KINDS.map(([value, name]) => ({ value, label: { ru: name } })),
  }),
  cardField('scale', 'Масштаб', 'Scale', 'select', {
    options: [
      { value: 'local', label: { ru: 'Локальный' } },
      { value: 'municipal', label: { ru: 'Местный' } },
      { value: 'regional', label: { ru: 'Региональный' } },
      { value: 'national', label: { ru: 'Республиканский' } },
      { value: 'transboundary', label: { ru: 'Трансграничный' } },
    ],
  }),
  cardField('territory', 'Район', 'District', 'territory', { required: true }),
  cardField('settlement', 'Населённый пункт', 'Settlement', 'text'),
  cardField('occurred_at', 'Время возникновения', 'Occurred at', 'datetime', { required: true }),
  cardField('injured', 'Пострадавшие', 'Injured', 'integer'),
  cardField('deaths', 'Погибшие', 'Deaths', 'integer'),
  cardField('evacuated', 'Эвакуировано, чел.', 'Evacuated', 'integer'),
  cardField('damage', 'Ущерб, сомони', 'Damage, TJS', 'money', {
    format: { precision: 2, currency: 'TJS', thousands: true },
  }),
  cardField('measures', 'Принятые меры', 'Measures taken', 'long_text'),
]

const ESCALATION: ProcessDefinitionInput['timers'] = [
  {
    step: '*',
    onOverdue: [
      { action: 'notify', to: 'manager(step.assignee)' },
      { action: 'notify', to: 'author' },
    ],
  },
]

const returnToAuthor = (next: string) => ({
  type: 'return' as const,
  name: { ru: 'Доработка автором', en: 'Revision by the author' },
  to: 'author',
  reapproval: 'full' as const,
  next,
})

/** Распоряжение штаба: согласование — час, подпись с подтверждением — два, номер по подписи. */
const DIRECTIVE_ROUTE: ProcessDefinitionInput = {
  version: 1,
  key: 'emergency_directive',
  objectType: 'document',
  name: {
    ru: 'Распоряжение штаба ЧС: экстренное подписание',
    en: 'Emergency HQ directive: urgent signing',
  },
  description: {
    ru: 'Согласующих выбирает инициатор — 1 час; подпись руководителя штаба с подтверждением — 2 часа; номер сразу после подписи. Сроки — календарные часы.',
    en: 'Approvers chosen by the initiator — 1 hour; confirmed signature — 2 hours; numbered on signing. Calendar hours.',
  },
  start: 'review',
  steps: {
    review: {
      type: 'approval',
      name: { ru: 'Экстренное согласование', en: 'Urgent approval' },
      mode: 'parallel',
      quorum: 'all',
      assignees: ['chosen_by_initiator'],
      dueHours: 1,
      onReject: 'return_to_author',
      allowAddApprover: true,
      next: 'sign',
    },
    sign: {
      type: 'sign',
      name: { ru: 'Подпись руководителя штаба', en: 'HQ head signature' },
      assignees: ['field:signer'],
      dueHours: 2,
      requireMfa: true,
      onReject: 'return_to_author',
      next: 'register',
    },
    register: {
      type: 'register',
      name: { ru: 'Регистрация', en: 'Registration' },
      next: 'end',
    },
    return_to_author: returnToAuthor('review'),
    end: { type: 'end', outcome: 'completed' },
  },
  timers: ESCALATION,
}

/** Оперативная сводка и донесение в вышестоящий орган: те же часы, регистрация канцелярией. */
const OUTGOING_ROUTE: ProcessDefinitionInput = {
  version: 1,
  key: 'emergency_outgoing',
  objectType: 'document',
  name: {
    ru: 'Оперативная сводка: экстренное согласование и отправка',
    en: 'Situation report: urgent approval and dispatch',
  },
  description: {
    ru: 'Согласующих выбирает инициатор — 1 час; подпись с подтверждением — 2 часа; регистрация — 1 час. Сроки — календарные часы.',
    en: 'Approvers chosen by the initiator — 1 hour; confirmed signature — 2 hours; registration — 1 hour. Calendar hours.',
  },
  start: 'review',
  steps: {
    review: {
      type: 'approval',
      name: { ru: 'Экстренное согласование', en: 'Urgent approval' },
      mode: 'parallel',
      quorum: 'all',
      assignees: ['chosen_by_initiator'],
      dueHours: 1,
      onReject: 'return_to_author',
      allowAddApprover: true,
      next: 'sign',
    },
    sign: {
      type: 'sign',
      name: { ru: 'Подпись руководителя', en: 'Head signature' },
      assignees: ['field:signer'],
      dueHours: 2,
      requireMfa: true,
      onReject: 'return_to_author',
      next: 'register',
    },
    register: {
      type: 'register',
      name: { ru: 'Регистрация исходящего', en: 'Outgoing registration' },
      assignees: ['role:registrar'],
      dueHours: 1,
      next: 'end',
    },
    return_to_author: returnToAuthor('review'),
    end: { type: 'end', outcome: 'completed' },
  },
  timers: ESCALATION,
}

interface PackJournal {
  key: string
  name: string
  prefix: string
  format: string
  unit?: string
}

const JOURNALS: readonly PackJournal[] = [
  {
    key: 'reports',
    name: 'Донесения о ЧС',
    prefix: 'ДН',
    format: '{prefix}-{seq:04}/{yy}',
    unit: 'UO-DUTY',
  },
  {
    key: 'directives',
    name: 'Распоряжения штаба ЧС',
    prefix: 'РШ',
    format: '{seq:03}-{prefix}/{yy}',
  },
  { key: 'protocols', name: 'Протоколы штаба ЧС', prefix: 'ПШ', format: '{seq:03}-{prefix}/{yy}' },
  { key: 'summaries', name: 'Оперативные сводки', prefix: 'СВ', format: '{prefix}-{seq:04}/{yy}' },
]

const baseSettings: DocumentTypeCreateInput['settings'] = {
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
}

interface PackType {
  key: string
  journal: string
  input: Omit<DocumentTypeCreateInput, 'key' | 'numbering'>
}

const TYPES: readonly PackType[] = [
  {
    key: 'hq_directive',
    journal: 'directives',
    input: {
      name: { ru: 'Распоряжение штаба ЧС', en: 'Emergency HQ directive' },
      direction: 'internal',
      cardSchema: { fields: [cardField('territory', 'Территория', 'Territory', 'territory')] },
      defaultRouteKey: 'emergency_directive',
      retentionYears: 10,
      confidentialityAllowed: ['public', 'internal', 'confidential'],
      defaultConfidentiality: 'internal',
      printForms: ['approval_sheet', 'acknowledgment_sheet'],
      settings: {
        ...baseSettings,
        ackOnRegister: true,
        autoControl: true,
        ackDueWorkingDays: 1,
      },
    },
  },
  {
    key: 'hq_protocol',
    journal: 'protocols',
    input: {
      name: { ru: 'Протокол заседания штаба ЧС', en: 'Emergency HQ meeting minutes' },
      direction: 'internal',
      cardSchema: { fields: [] },
      defaultRouteKey: null,
      retentionYears: 10,
      confidentialityAllowed: ['public', 'internal', 'confidential'],
      defaultConfidentiality: 'internal',
      printForms: ['acknowledgment_sheet'],
      settings: { ...baseSettings, autoControl: true },
    },
  },
  {
    key: 'summary_report',
    journal: 'summaries',
    input: {
      name: { ru: 'Оперативная сводка', en: 'Situation summary' },
      direction: 'outgoing',
      cardSchema: {
        fields: [
          cardField('period_from', 'Период с', 'Period from', 'datetime'),
          cardField('period_to', 'Период по', 'Period to', 'datetime'),
          cardField('addressee', 'Адресат', 'Addressee', 'text'),
        ],
      },
      defaultRouteKey: 'emergency_outgoing',
      retentionYears: 5,
      confidentialityAllowed: ['public', 'internal', 'confidential'],
      defaultConfidentiality: 'internal',
      printForms: ['approval_sheet', 'dispatch_register'],
      settings: baseSettings,
    },
  },
]

async function ensureJournals(pack: PackContext, dutyGroup: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const journal of JOURNALS) {
    const [existing] = await db()
      .select({ id: journals.id })
      .from(journals)
      .where(eq(journals.name, journal.name))
      .limit(1)
    if (existing) {
      ids.set(journal.key, existing.id)
      continue
    }
    const unit = journal.unit && pack.demo ? await unitId(journal.unit) : null
    const id = await db().transaction(async (tx) => {
      const created = await JournalService.create(tx, pack.ctx, {
        name: journal.name,
        prefix: journal.prefix,
        format: journal.format,
        reset: 'year',
        unitId: unit,
        typeIds: [],
      })
      // Донесения регистрирует и дежурная смена, не только канцелярия
      if (journal.key === 'reports') {
        await grantAccess(tx, pack.ctx, created, [
          { principal: { type: 'group', id: dutyGroup }, level: 'edit' },
        ])
      }
      return created
    })
    ids.set(journal.key, id)
  }
  return ids
}

/**
 * «Донесение» из стартового набора получает реквизиты ЧС и журнал донесений — один раз:
 * поля, уже заведённые администратором, и выбранный им журнал не трогаются.
 */
async function enrichReport(pack: PackContext, journalId: string): Promise<boolean> {
  const [type] = await db()
    .select({
      id: documentTypes.id,
      cardSchema: documentTypes.cardSchema,
      numbering: documentTypes.numbering,
    })
    .from(documentTypes)
    .where(eq(documentTypes.key, 'situation_report'))
    .limit(1)
  if (!type) return false
  const fields = (type.cardSchema as { fields?: FieldDef[] } | null)?.fields ?? []
  const present = new Set(fields.map((item) => item.key))
  const added = REPORT_FIELDS.filter((item) => !present.has(item.key))
  if (added.length === 0) return false
  const numbering = type.numbering as { journalId: string | null; format: string | null } | null
  await db().transaction((tx) =>
    DocumentTypeService.update(tx, pack.ctx, type.id, {
      cardSchema: { fields: [...fields, ...added] },
      // Журнал меняется, только пока донесения ещё не получили своего журнала
      ...(fields.length === 0
        ? { numbering: { journalId, format: numbering?.format ?? null } }
        : {}),
      printForms: ['registration_card', 'registration_stamp'],
    }),
  )
  return true
}

export async function ensureDocuments(
  pack: PackContext,
  groups: { duty: string },
): Promise<{ routes: number; types: string[] }> {
  let routes = 0
  for (const definition of [DIRECTIVE_ROUTE, OUTGOING_ROUTE]) {
    if (await db().transaction((tx) => ProcessDefinitions.ensure(tx, pack.ctx, definition))) {
      routes += 1
    }
  }
  const journalIds = await ensureJournals(pack, groups.duty)
  const types: string[] = []
  for (const type of TYPES) {
    const [existing] = await db()
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.key, type.key))
      .limit(1)
    if (existing) continue
    await db().transaction((tx) =>
      DocumentTypeService.create(tx, pack.ctx, {
        ...type.input,
        key: type.key,
        numbering: { journalId: journalIds.get(type.journal) ?? null, format: null },
      }),
    )
    types.push(type.key)
  }
  const report = await enrichReport(pack, journalIds.get('reports') as string)
  pack.log('документы штаба готовы', { routes, types, report })
  return { routes, types }
}
