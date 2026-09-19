import type {
  DocumentDirection,
  DocumentTypeCreateInput,
  FieldDef,
  LangText,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { correspondents, documentTypes, journals } from '~/shared/db/schema/index.js'
import { CorrespondentService } from './correspondent-service.js'
import { JournalService } from './journal-service.js'
import { ensureStarterRoutes } from './routes/starter-routes.js'
import { DocumentTypeService } from './type-service.js'

interface StarterJournal {
  key: string
  name: string
  prefix: string
  format?: string
}

/** Стартовые журналы (08-documents.md §5): входящие, исходящие, внутренние, приказы… */
const JOURNALS: StarterJournal[] = [
  { key: 'incoming', name: 'Входящие', prefix: 'ВХ' },
  { key: 'outgoing', name: 'Исходящие', prefix: 'ИСХ' },
  { key: 'internal', name: 'Внутренние', prefix: 'ВН' },
  { key: 'orders', name: 'Приказы', prefix: 'ПР', format: '{seq:03}-{prefix}/{yy}' },
  { key: 'directives', name: 'Распоряжения', prefix: 'РП', format: '{seq:03}-{prefix}/{yy}' },
  { key: 'contracts', name: 'Договоры', prefix: 'ДГ' },
  { key: 'appeals', name: 'Обращения граждан', prefix: 'ОГ' },
]

const text = (key: string, label: LangText, extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  type: 'text',
  semantic: 'text',
  required: false,
  unique: false,
  indexed: false,
  sensitive: false,
  readOnly: false,
  nullable: true,
  order: 0,
  ...extra,
})

interface StarterType {
  key: string
  name: LangText
  direction: DocumentDirection
  journal: string
  fields?: FieldDef[]
  settings?: Partial<DocumentTypeCreateInput['settings']>
  confidentialityAllowed?: DocumentTypeCreateInput['confidentialityAllowed']
  retentionYears?: number
  printForms?: string[]
}

/** Стартовый набор типов (08-documents.md §2) — редактируемый справочник. */
const TYPES: StarterType[] = [
  {
    key: 'incoming_letter',
    name: { ru: 'Входящее письмо', tg: 'Мактуби воридотӣ', en: 'Incoming letter' },
    direction: 'incoming',
    journal: 'incoming',
    settings: { requireScan: true, autoControl: true, resolutionBy: 'unit_head' },
    fields: [
      text(
        'pages',
        { ru: 'Листов', tg: 'Варақҳо', en: 'Pages' },
        { type: 'integer', semantic: 'measure', order: 1 },
      ),
      text('enclosures', { ru: 'Приложения', tg: 'Замимаҳо', en: 'Enclosures' }, { order: 2 }),
    ],
    retentionYears: 5,
    printForms: ['registration_card', 'registration_stamp'],
  },
  {
    key: 'outgoing_letter',
    name: { ru: 'Исходящее письмо', tg: 'Мактуби содиротӣ', en: 'Outgoing letter' },
    direction: 'outgoing',
    journal: 'outgoing',
    fields: [text('addressee', { ru: 'Адресат', tg: 'Қабулкунанда', en: 'Addressee' })],
    retentionYears: 5,
    printForms: ['approval_sheet', 'dispatch_register'],
  },
  {
    key: 'memo',
    name: { ru: 'Служебная записка', tg: 'Мактуби хизматӣ', en: 'Memo' },
    direction: 'internal',
    journal: 'internal',
    retentionYears: 3,
  },
  {
    key: 'report_memo',
    name: { ru: 'Докладная записка', tg: 'Маърӯзаномаи хизматӣ', en: 'Report memo' },
    direction: 'internal',
    journal: 'internal',
    retentionYears: 3,
  },
  {
    key: 'order',
    name: { ru: 'Приказ', tg: 'Фармоиш', en: 'Order' },
    direction: 'internal',
    journal: 'orders',
    settings: { ackOnRegister: true, autoControl: true, ackDueWorkingDays: 3 },
    retentionYears: 75,
    printForms: ['approval_sheet', 'acknowledgment_sheet'],
  },
  {
    key: 'directive',
    name: { ru: 'Распоряжение', tg: 'Амр', en: 'Directive' },
    direction: 'internal',
    journal: 'directives',
    settings: { ackOnRegister: true, autoControl: true, ackDueWorkingDays: 3 },
    retentionYears: 10,
  },
  {
    key: 'protocol',
    name: { ru: 'Протокол', tg: 'Суратҷаласа', en: 'Minutes' },
    direction: 'internal',
    journal: 'internal',
    retentionYears: 10,
  },
  {
    key: 'contract',
    name: { ru: 'Договор / соглашение', tg: 'Шартнома', en: 'Contract / agreement' },
    direction: 'internal',
    journal: 'contracts',
    fields: [
      text(
        'amount',
        { ru: 'Сумма', tg: 'Маблағ', en: 'Amount' },
        { type: 'money', semantic: 'measure', format: { currency: 'TJS' }, order: 1 },
      ),
      text(
        'valid_until',
        { ru: 'Действует до', tg: 'То', en: 'Valid until' },
        { type: 'date', semantic: 'time', order: 2 },
      ),
    ],
    retentionYears: 5,
  },
  {
    key: 'appeal',
    name: { ru: 'Обращение', tg: 'Муроҷиат', en: 'Appeal' },
    direction: 'incoming',
    journal: 'appeals',
    settings: { autoControl: true, defaultDeadlineDays: 15, resolutionBy: 'unit_head' },
    fields: [
      text('applicant_address', { ru: 'Адрес заявителя', tg: 'Суроғаи довталаб', en: 'Address' }),
    ],
    retentionYears: 5,
  },
  {
    key: 'registered_report',
    name: { ru: 'Отчёт (регистрируемый)', tg: 'Ҳисобот', en: 'Registered report' },
    direction: 'internal',
    journal: 'internal',
    retentionYears: 5,
  },
  {
    key: 'situation_report',
    name: { ru: 'Донесение', tg: 'Хабарнома', en: 'Situation report' },
    direction: 'incoming',
    journal: 'incoming',
    settings: { autoControl: true, resolutionBy: 'unit_head' },
    confidentialityAllowed: ['internal', 'confidential', 'secret'],
    retentionYears: 10,
  },
]

/** Корреспонденты демо-мира — синтетические, для регистрации входящих. */
const DEMO_CORRESPONDENTS: Array<{ name: string; shortName: string; kind: 'organization' }> = [
  {
    name: 'Министерство финансов Республики Таджикистан',
    shortName: 'Минфин',
    kind: 'organization',
  },
  {
    name: 'Агентство по гидрометеорологии Комитета охраны окружающей среды',
    shortName: 'Гидромет',
    kind: 'organization',
  },
  { name: 'Хукумат Согдийской области', shortName: 'Хукумат Согда', kind: 'organization' },
  { name: 'Хукумат Хатлонской области', shortName: 'Хукумат Хатлона', kind: 'organization' },
  { name: 'ОАО «Барки Точик»', shortName: 'Барки Точик', kind: 'organization' },
  {
    name: 'Министерство здравоохранения и социальной защиты населения',
    shortName: 'Минздрав',
    kind: 'organization',
  },
]

export interface StarterSetSummary {
  journals: number
  types: number
  correspondents: number
  /** Стартовые маршруты согласования (ADR-0083). */
  routes: number
}

/**
 * Стартовый набор документооборота (08-documents.md §2, §4, §5): журналы, типы
 * и маршруты согласования — идемпотентно (по названию журнала, ключу типа и
 * ключу маршрута; существующие не меняются — справочник редактируемый), в
 * `kchs init` и `db:seed`. Корреспонденты — только демо-миру.
 */
export async function ensureStarterSet(
  ctx: Ctx,
  options: { unitId?: string | null; demo?: boolean } = {},
): Promise<StarterSetSummary> {
  const summary: StarterSetSummary = { journals: 0, types: 0, correspondents: 0, routes: 0 }
  const journalIds = new Map<string, string>()
  for (const journal of JOURNALS) {
    const [existing] = await db()
      .select({ id: journals.id })
      .from(journals)
      .where(eq(journals.name, journal.name))
      .limit(1)
    if (existing) {
      journalIds.set(journal.key, existing.id)
      continue
    }
    const id = await db().transaction((tx) =>
      JournalService.create(tx, ctx, {
        name: journal.name,
        prefix: journal.prefix,
        format: journal.format ?? '{prefix}-{seq:04}/{yy}',
        reset: 'year',
        unitId: options.unitId ?? null,
        typeIds: [],
      }),
    )
    journalIds.set(journal.key, id)
    summary.journals += 1
  }

  for (const type of TYPES) {
    const [existing] = await db()
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.key, type.key))
      .limit(1)
    if (existing) continue
    await db().transaction((tx) =>
      DocumentTypeService.create(tx, ctx, {
        key: type.key,
        name: type.name,
        direction: type.direction,
        cardSchema: { fields: type.fields ?? [] },
        numbering: { journalId: journalIds.get(type.journal) ?? null, format: null },
        defaultRouteKey: null,
        retentionYears: type.retentionYears ?? null,
        confidentialityAllowed: type.confidentialityAllowed ?? [
          'public',
          'internal',
          'confidential',
        ],
        defaultConfidentiality: 'internal',
        printForms: type.printForms ?? [],
        settings: {
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
          ...type.settings,
        },
      }),
    )
    summary.types += 1
  }

  // Маршруты — после типов: тип получает маршрут по умолчанию
  summary.routes = await ensureStarterRoutes(ctx)

  if (options.demo) {
    for (const item of DEMO_CORRESPONDENTS) {
      const [existing] = await db()
        .select({ id: correspondents.id })
        .from(correspondents)
        .where(eq(correspondents.name, item.name))
        .limit(1)
      if (existing) continue
      await db().transaction((tx) =>
        CorrespondentService.create(tx, ctx, {
          kind: item.kind,
          name: item.name,
          details: { shortName: item.shortName },
          contacts: {},
          externalId: null,
        }),
      )
      summary.correspondents += 1
    }
  }
  return summary
}
