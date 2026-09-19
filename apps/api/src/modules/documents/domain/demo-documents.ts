import type { DeliveryMethod, DocumentStatus } from '@kchs/contracts'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { addDays } from '~/kernel/business-calendar/working-days.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { deleteObject, putObject } from '~/kernel/storage/s3.js'
import { registerStoredFile } from '~/modules/files/public.js'
import { type SystemCtx, systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { newId } from '~/shared/ids.js'
import { cases, correspondents, documents, objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { CaseService } from './case-service.js'
import { Correspondence } from './correspondence-service.js'
import { CorrespondentService } from './correspondent-service.js'
import { DocumentService } from './document-service.js'
import { todayLocal } from './journal-service.js'
import { applyTransition } from './lifecycle.js'
import { documentsSpaceId } from './space.js'
import { DocumentTypeService } from './type-service.js'
import { DocumentVersionService } from './version-service.js'

/** Сотрудник демо-мира: id и основное подразделение. */
export interface DemoPerson {
  id: string
  unitId: string | null
}

/** Кто работает с демо-документами: делопроизводители, руководители, исполнители. */
export interface DemoDocumentPeople {
  registrars: DemoPerson[]
  heads: DemoPerson[]
  staff: DemoPerson[]
  /** Подразделение канцелярии — владелец номенклатуры дел. */
  officeUnitId: string | null
}

export interface DemoDocumentsSummary {
  documents: number
  cases: number
  skipped: boolean
}

/** Детерминированный генератор: один и тот же сид — одни и те же документы. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.floor(random() * list.length)] as T

// Синтетические темы и корреспонденты демо-мира — без реальных персональных данных
const INCOMING = [
  'О паводковой обстановке в бассейне реки Вахш',
  'О выделении средств на восстановление защитных дамб',
  'О проведении командно-штабных учений',
  'О готовности пунктов временного размещения',
  'О графике плановых отключений электроэнергии',
  'О санитарно-эпидемиологической обстановке в зоне подтопления',
  'О представлении сведений о резервах материальных средств',
  'О прогнозе схода селей в весенний период',
  'Об уточнении списка потенциально опасных объектов',
  'О согласовании плана эвакуации населения',
  'О ходе ремонта средств оповещения',
  'О мерах по безопасности на водных объектах',
] as const
const OUTGOING = [
  'О направлении сводки по паводковой обстановке',
  'О представлении плана мероприятий на квартал',
  'О согласовании состава оперативной группы',
  'О проведении совместной проверки готовности',
  'Об информировании населения о мерах безопасности',
  'О запросе сведений о техническом состоянии дамб',
] as const
const ORDERS = [
  'О назначении ответственных на паводкоопасный период',
  'Об утверждении плана учений на квартал',
  'О создании оперативной группы',
  'Об организации круглосуточного дежурства',
  'О проведении инвентаризации техники',
] as const
const MEMOS = [
  'О потребности в спасательном оборудовании',
  'О результатах выезда в район подтопления',
  'О предоставлении отгулов дежурной смене',
  'О замене средств связи оперативной группы',
  'О подготовке справки для руководства',
] as const
const APPEALS = [
  'О подтоплении приусадебного участка',
  'О восстановлении пешеходного моста',
  'О переселении из зоны риска схода селей',
  'Об очистке ирригационного канала',
] as const
const REPORTS = [
  'Донесение о повышении уровня воды',
  'Донесение о сходе селя на автодороге',
  'Донесение о результатах обследования дамбы',
] as const
/** Заявители обращений — вымышленные. */
const APPLICANTS = ['Заявитель Р. Каримов', 'Заявитель М. Шарипова', 'Заявитель Д. Саидов'] as const
const METHODS: DeliveryMethod[] = ['post', 'email', 'courier', 'edms']

/** Номенклатура канцелярии: индекс, заголовок, типы документов, срок хранения. */
const NOMENCLATURE = [
  { index: '01-01', title: 'Приказы по основной деятельности', types: ['order'], years: null },
  {
    index: '01-05',
    title: 'Входящая корреспонденция',
    types: ['incoming_letter', 'situation_report'],
    years: 5,
  },
  { index: '01-06', title: 'Исходящая корреспонденция', types: ['outgoing_letter'], years: 5 },
  { index: '01-07', title: 'Обращения граждан и ответы на них', types: ['appeal'], years: 5 },
  {
    index: '01-08',
    title: 'Служебные и докладные записки',
    types: ['memo', 'report_memo'],
    years: 3,
  },
] as const

/** Одностраничный PDF-«скан» (латиница: без встроенного шрифта). */
function demoScanPdf(label: string): Buffer {
  const ascii = [...label]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127)
    .join('')
    .replace(/[()\\]/g, ' ')
  const stream = `BT /F1 20 Tf 72 760 Td (kchs demo scan) Tj 0 -32 Td (${ascii}) Tj ET`
  const parts = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  parts.forEach((part, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${part}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** План одного демо-документа — до создания. */
interface Plan {
  key: string
  typeKey: string
  subject: string
  regDate: string | null
  status: 'draft' | 'registered' | 'executed' | 'filed' | 'archived' | 'cancelled'
  authorId: string
  responsibleId: string | null
  controllerId: string | null
  signerId: string | null
  unitId: string | null
  correspondentId: string | null
  control: boolean
  deadline: string | null
  scan: boolean
  /** Ключ входящего, на который отвечает этот исходящий. */
  replyTo: string | null
  caseKey: string | null
}

/**
 * Демо-документы сида (P3-E05 S02, ADR-0086): около двухсот синтетических
 * документов за прошлый и текущий год — входящие со сканами, исходящие-ответы
 * со связью «в ответ на» и отметкой отправки, приказы, служебные записки,
 * обращения, донесения; статусы от черновика до архива, номенклатура дел
 * канцелярии по годам, дела прошлого года — в архиве, одно старое дело — со
 * сроком хранения, истёкшим для акта об уничтожении. Всё — доменными
 * действиями модуля. Повторный запуск ничего не добавляет (метка `demoKey`).
 * Маршруты и резолюции — не здесь: их добавят ветки маршрутов и резолюций.
 */
export async function seedDemoDocuments(people: DemoDocumentPeople): Promise<DemoDocumentsSummary> {
  const log = logger().child({ module: 'seed.documents' })
  const [already] = await db()
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.type, 'document'), isNotNull(sql`${objects.meta}->>'demoKey'`)))
    .limit(1)
  if (already) return { documents: 0, cases: 0, skipped: true }
  const registrar = people.registrars[0]
  if (!registrar || people.heads.length === 0 || people.staff.length === 0) {
    log.warn('демо-документы пропущены: нет делопроизводителя, руководителей или исполнителей')
    return { documents: 0, cases: 0, skipped: true }
  }

  const random = makeRandom(20_260_919)
  const today = todayLocal()
  const year = Number(today.slice(0, 4))
  const ctxOf = (userId: string): SystemCtx => systemCtx('seed.documents', { initiatorId: userId })
  const office = ctxOf(registrar.id)
  const spaceId = await db().transaction((tx) => documentsSpaceId(tx))

  // Корреспонденты: демо-организации стартового набора и вымышленные заявители
  const orgs = await db()
    .select({ id: correspondents.id, name: correspondents.name })
    .from(correspondents)
    .where(eq(correspondents.kind, 'organization'))
    .limit(20)
  if (orgs.length === 0) {
    log.warn('демо-документы пропущены: нет корреспондентов (нужен стартовый набор demo)')
    return { documents: 0, cases: 0, skipped: true }
  }
  const applicants: string[] = []
  for (const name of APPLICANTS) {
    const [found] = await db()
      .select({ id: correspondents.id })
      .from(correspondents)
      .where(eq(correspondents.name, name))
      .limit(1)
    applicants.push(
      found?.id ??
        (await db().transaction((tx) =>
          CorrespondentService.create(tx, office, {
            kind: 'person',
            name,
            details: { note: 'Демо-данные' },
            contacts: {},
            externalId: null,
          }),
        )),
    )
  }

  // ── Номенклатура дел: прошлый и текущий год, одно старое дело записок ─────
  const caseIds = new Map<string, string>()
  const caseKey = (index: string, caseYear: number) => `${caseYear}:${index}`
  const ensureCase = async (item: (typeof NOMENCLATURE)[number], caseYear: number) => {
    const [found] = await db()
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.year, caseYear), sql`lower(${cases.index}) = lower(${item.index})`))
      .limit(1)
    const types = await Promise.all(item.types.map((key) => DocumentTypeService.byKey(db(), key)))
    const id =
      found?.id ??
      (await db().transaction((tx) =>
        CaseService.create(tx, office, {
          index: item.index,
          title: item.title,
          year: caseYear,
          unitId: people.officeUnitId,
          retentionYears: item.years,
          retentionNote: item.years === null ? 'Хранится постоянно' : null,
          documentTypeIds: types.filter((type) => type !== null).map((type) => type.id),
          note: null,
        }),
      ))
    caseIds.set(caseKey(item.index, caseYear), id)
  }
  for (const caseYear of [year - 1, year]) {
    for (const item of NOMENCLATURE) await ensureCase(item, caseYear)
  }
  const memosCase = NOMENCLATURE.find((item) => item.index === '01-08')
  if (memosCase) await ensureCase(memosCase, year - 5)

  // ── План документов ──────────────────────────────────────────────────────
  const plans: Plan[] = []
  let serial = 0
  const staff = () => pick(people.staff, random)
  const head = () => pick(people.heads, random)
  const dayIn = (planYear: number, month: number, day: number) =>
    `${planYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  /** Дата регистрации: прошлый год — весь, текущий — не позже сегодняшнего дня. */
  const dateOf = (planYear: number, share: number): string => {
    const start = Date.parse(`${planYear}-01-10T00:00:00Z`)
    const end = planYear < year ? Date.parse(`${planYear}-12-20T00:00:00Z`) : Date.parse(today)
    const at = new Date(start + Math.max(0, end - start) * share)
    return minDate(at.toISOString().slice(0, 10), today)
  }
  const plan = (input: Partial<Plan> & Pick<Plan, 'typeKey' | 'subject' | 'status'>): Plan => {
    serial += 1
    const author = staff()
    const entry: Plan = {
      key: `demo-doc:${serial}`,
      regDate: null,
      authorId: author.id,
      responsibleId: author.id,
      controllerId: null,
      signerId: null,
      unitId: author.unitId,
      correspondentId: null,
      control: false,
      deadline: null,
      scan: false,
      replyTo: null,
      caseKey: null,
      ...input,
    }
    plans.push(entry)
    return entry
  }

  /** Статус по доле: сначала завершённые, дальше — в работе. */
  const statusFor = (share: number, planYear: number): Plan['status'] => {
    if (planYear < year) return 'archived'
    if (share < 0.45) return 'filed'
    if (share < 0.7) return 'executed'
    return 'registered'
  }

  for (const [planYear, count] of [
    [year - 1, 28],
    [year, 52],
  ] as const) {
    for (let index = 0; index < count; index++) {
      const share = (index + random() * 0.5) / count
      const regDate = dateOf(planYear, share)
      const status = statusFor(share, planYear)
      const controller = head()
      const onControl = status === 'registered' || random() < 0.4
      const letter = plan({
        typeKey: 'incoming_letter',
        subject: pick(INCOMING, random),
        status,
        regDate,
        correspondentId: pick(orgs, random).id,
        control: onControl,
        controllerId: onControl ? controller.id : null,
        // Часть открытых — просрочена: срок в прошлом
        deadline: addDays(regDate, status === 'registered' && index % 3 === 0 ? 5 : 20),
        scan: true,
        caseKey: status === 'filed' || status === 'archived' ? caseKey('01-05', planYear) : null,
      })
      // Каждое второе входящее — с ответом: исходящий в ответ на него
      if (index % 2 === 0) {
        const replyStatus: Plan['status'] =
          status === 'archived'
            ? 'archived'
            : status === 'filed'
              ? 'filed'
              : status === 'executed'
                ? 'executed'
                : 'draft'
        plan({
          typeKey: 'outgoing_letter',
          subject: letter.subject,
          status: replyStatus,
          regDate: replyStatus === 'draft' ? null : minDate(addDays(regDate, 4), today),
          authorId: letter.responsibleId ?? letter.authorId,
          responsibleId: letter.responsibleId,
          signerId: head().id,
          correspondentId: letter.correspondentId,
          replyTo: letter.key,
          caseKey:
            replyStatus === 'filed' || replyStatus === 'archived'
              ? caseKey('01-06', planYear)
              : null,
        })
      }
    }

    // Исходящие по инициативе канцелярии
    const outgoing = planYear < year ? 6 : 12
    for (let index = 0; index < outgoing; index++) {
      const share = (index + random() * 0.5) / outgoing
      const status: Plan['status'] =
        planYear < year
          ? 'archived'
          : index < 3
            ? 'draft'
            : index < 6
              ? 'registered'
              : index < 9
                ? 'executed'
                : 'filed'
      plan({
        typeKey: 'outgoing_letter',
        subject: pick(OUTGOING, random),
        status,
        regDate: status === 'draft' ? null : dateOf(planYear, share),
        signerId: head().id,
        correspondentId: pick(orgs, random).id,
        caseKey: status === 'filed' || status === 'archived' ? caseKey('01-06', planYear) : null,
      })
    }

    // Приказы
    const orders = planYear < year ? 7 : 10
    for (let index = 0; index < orders; index++) {
      const share = (index + random() * 0.5) / orders
      const status: Plan['status'] =
        planYear < year ? 'archived' : index < 4 ? 'registered' : index < 6 ? 'executed' : 'filed'
      const chief = head()
      plan({
        typeKey: 'order',
        subject: pick(ORDERS, random),
        status,
        regDate: dateOf(planYear, share),
        signerId: chief.id,
        control: status === 'registered',
        controllerId: status === 'registered' ? chief.id : null,
        deadline: status === 'registered' ? addDays(dateOf(planYear, share), 30) : null,
        caseKey: status === 'filed' || status === 'archived' ? caseKey('01-01', planYear) : null,
      })
    }
  }

  // Служебные записки текущего года — от черновиков до дела
  const memos = 20
  for (let index = 0; index < memos; index++) {
    const share = (index + random() * 0.5) / memos
    const status: Plan['status'] =
      index < 4
        ? 'draft'
        : index < 7
          ? 'cancelled'
          : index < 12
            ? 'registered'
            : index < 16
              ? 'executed'
              : 'filed'
    plan({
      typeKey: index % 3 === 0 ? 'report_memo' : 'memo',
      subject: pick(MEMOS, random),
      status,
      regDate: status === 'draft' || status === 'cancelled' ? null : dateOf(year, share),
      signerId: head().id,
      caseKey: status === 'filed' ? caseKey('01-08', year) : null,
    })
  }
  // Старое дело записок: срок хранения истёк — его можно выделить к уничтожению
  for (let index = 0; index < 4; index++) {
    plan({
      typeKey: 'memo',
      subject: pick(MEMOS, random),
      status: 'archived',
      regDate: dayIn(year - 5, 3 + index * 2, 12),
      signerId: head().id,
      caseKey: caseKey('01-08', year - 5),
    })
  }

  // Обращения граждан: срок по умолчанию 15 рабочих дней, автоконтроль
  const appeals = 12
  for (let index = 0; index < appeals; index++) {
    const share = (index + random() * 0.5) / appeals
    const status: Plan['status'] = index < 5 ? 'filed' : index < 8 ? 'executed' : 'registered'
    plan({
      typeKey: 'appeal',
      subject: pick(APPEALS, random),
      status,
      regDate: dateOf(year, share),
      correspondentId: pick(applicants, random),
      controllerId: head().id,
      caseKey: status === 'filed' ? caseKey('01-07', year) : null,
    })
  }

  // Донесения с мест — на контроле
  for (let index = 0; index < 6; index++) {
    const regDate = dateOf(year, 0.6 + index * 0.06)
    const status: Plan['status'] = index < 2 ? 'executed' : 'registered'
    plan({
      typeKey: 'situation_report',
      subject: pick(REPORTS, random),
      status,
      regDate,
      correspondentId: pick(orgs, random).id,
      control: true,
      controllerId: head().id,
      deadline: addDays(regDate, index % 2 === 0 ? 3 : 25),
    })
  }

  // ── Исполнение плана: хронологически — номера журналов идут по датам ─────
  plans.sort((a, b) => (a.regDate ?? '9999').localeCompare(b.regDate ?? '9999'))
  const ids = new Map<string, string>()
  const types = new Map<string, Awaited<ReturnType<typeof DocumentTypeService.byKey>>>()
  const typeOf = async (key: string) => {
    if (!types.has(key)) types.set(key, await DocumentTypeService.byKey(db(), key))
    const type = types.get(key)
    if (!type) throw new Error(`демо-документы: нет типа ${key}`)
    return type
  }
  let scans = 0
  const batch = newId()
  for (const item of plans) {
    const type = await typeOf(item.typeKey)
    const author = ctxOf(item.authorId)
    const incoming = type.direction === 'incoming'
    const id = await db().transaction(async (tx) => {
      const created = await DocumentService.create(tx, author, {
        typeId: type.id,
        subject: item.subject,
        correspondentId: item.correspondentId,
        ...(incoming && item.regDate
          ? {
              receivedDate: item.regDate,
              externalNumber: `${String(plans.indexOf(item) + 1).padStart(3, '0')}/${item.regDate.slice(2, 4)}`,
              externalDate: addDays(item.regDate, -3),
              deliveryMethod: pick(METHODS, random),
            }
          : {}),
        responsibleId: item.responsibleId,
        signerId: item.signerId,
        controllerId: item.controllerId,
        control: item.control ? 'on' : 'none',
        deadline: item.deadline,
        unitId: item.unitId,
        ...(type.cardSchema.fields.some((field) => field.key === 'addressee') &&
        item.correspondentId
          ? { fields: { addressee: orgs.find((org) => org.id === item.correspondentId)?.name } }
          : {}),
      })
      await ObjectService.update(
        tx,
        author,
        created,
        { meta: { demoKey: item.key }, mergeMeta: true },
        { silent: true },
      )
      const target = item.replyTo ? ids.get(item.replyTo) : undefined
      if (target) await LinkService.link(tx, author, created, target, 'reply_to')
      return created
    })
    ids.set(item.key, id)

    // Скан входящего письма — вложение и версия документа (правило типа)
    if (item.scan && item.regDate) {
      scans += 1
      // Источник копии — временный ключ прогона: стенды на одном хранилище не мешают друг другу
      const sourceKey = `demo/documents/${batch}/scan-${scans}.pdf`
      const pdf = demoScanPdf(`Incoming ${item.regDate} #${scans}`)
      await putObject(sourceKey, pdf, { contentType: 'application/pdf', contentLength: pdf.length })
      const file = await registerStoredFile(author, {
        spaceId,
        attachToObjectId: id,
        name: `Скан ${item.regDate}.pdf`,
        mime: 'application/pdf',
        sourceKey,
      })
      await deleteObject(sourceKey)
      await db().transaction((tx) =>
        DocumentVersionService.add(tx, author, id, {
          mainFileId: file.id,
          attachmentIds: [],
          note: null,
        }),
      )
    }

    if (item.status === 'draft') continue
    if (item.status === 'cancelled') {
      await db().transaction((tx) =>
        DocumentService.cancel(tx, author, id, {
          reason: 'Подготовлен повторно, вариант не нужен',
        }),
      )
      continue
    }
    await db().transaction(async (tx) => {
      await DocumentService.register(tx, office, id, {}, { date: item.regDate ?? today })
      if (item.status === 'registered') return
      if (type.direction === 'outgoing') {
        await Correspondence.dispatch(tx, office, id, {
          correspondentId: item.correspondentId,
          addressee: null,
          method: pick(METHODS, random),
          sentOn: minDate(addDays(item.regDate ?? today, 1), today),
          tracking: null,
          note: null,
        })
      } else {
        await applyTransition(tx, office, id, { to: 'executed', cause: 'execution' })
      }
      const caseId = item.caseKey ? caseIds.get(item.caseKey) : undefined
      if ((item.status === 'filed' || item.status === 'archived') && caseId) {
        await CaseService.fileDocument(tx, office, id, caseId)
      }
    })
  }

  // ── Дела прошлых лет: закрыты и переданы в архив вместе с документами ────
  const pastCases = [...caseIds.entries()].filter(([key]) => Number(key.split(':')[0]) < year)
  for (const [, caseId] of pastCases) {
    await db().transaction(async (tx) => {
      const row = await CaseService.load(tx, caseId)
      if (row?.status === 'open') await CaseService.close(tx, office, caseId)
    })
    await db().transaction(async (tx) => {
      const row = await CaseService.load(tx, caseId)
      if (row?.status === 'closed') await CaseService.archive(tx, office, caseId)
    })
  }

  const statuses = await db()
    .select({ status: documents.status, total: sql<number>`count(*)::int` })
    .from(documents)
    .where(inArray(documents.id, [...ids.values()]))
    .groupBy(documents.status)
  log.info(
    {
      documents: ids.size,
      cases: caseIds.size,
      statuses: Object.fromEntries(
        statuses.map((row) => [row.status as DocumentStatus, row.total]),
      ),
    },
    'демо-документы созданы',
  )
  return { documents: ids.size, cases: caseIds.size, skipped: false }
}

function minDate(a: string, b: string): string {
  return a < b ? a : b
}
