import {
  type Confidentiality,
  canTransition,
  type DeliveryMethod,
  type DocumentCancelInput,
  type DocumentControl,
  type DocumentCreateInput,
  type DocumentRecord,
  type DocumentRegisterInput,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentUpdateInput,
  isDocumentClosed,
  type Level,
  levelValue,
  parseConfidentiality,
  type UserRef,
  withinClearance,
} from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { authorize, hasCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { clearanceOf } from '~/kernel/access/confidentiality.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { allowedActions } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { ProcessDefinitions, ProcessService } from '~/kernel/process/index.js'
import { territoryIndex } from '~/modules/gis/public.js'
import { OrgService } from '~/modules/identity/public.js'
import { actorId, type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documents, journals, objects, registrations } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { assertRequisites, validateCardFields } from './card.js'
import { CorrespondentService } from './correspondent-service.js'
import { JournalService, todayLocal } from './journal-service.js'
import { applyTransition } from './lifecycle.js'
import { CARD_LEVELS, DocumentParticipants, refreshViewers } from './participants.js'
import { activeRoute, ROUTE_ACTIVE_STATUSES, routeBlocker } from './routes/state.js'
import { documentsSpaceId } from './space.js'
import { type DocumentTypeRow, DocumentTypeService } from './type-service.js'
import { DocumentVersionService } from './version-service.js'

const COLUMNS = {
  id: documents.id,
  typeId: documents.typeId,
  status: documents.status,
  regNumber: documents.regNumber,
  regDate: documents.regDate,
  journalId: documents.journalId,
  subject: documents.subject,
  summary: documents.summary,
  correspondentId: documents.correspondentId,
  externalNumber: documents.externalNumber,
  externalDate: documents.externalDate,
  receivedDate: documents.receivedDate,
  deliveryMethod: documents.deliveryMethod,
  authorId: documents.authorId,
  responsibleId: documents.responsibleId,
  signerId: documents.signerId,
  deadline: documents.deadline,
  control: documents.control,
  controllerId: documents.controllerId,
  confidentiality: documents.confidentiality,
  fields: documents.fields,
  currentVersionId: documents.currentVersionId,
  territoryId: documents.territoryId,
  unitId: documents.unitId,
  cancelledAt: documents.cancelledAt,
  cancelReason: documents.cancelReason,
  spaceId: objects.spaceId,
  ownerId: objects.ownerId,
  title: objects.title,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
  version: objects.version,
}

async function loadRow(executor: Executor, id: string, lock = false) {
  const query = executor
    .select(COLUMNS)
    .from(documents)
    .innerJoin(objects, eq(objects.id, documents.id))
    .where(and(eq(documents.id, id), sql`${objects.deletedAt} IS NULL`))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: documents }) : await query
  return row ?? null
}

type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>

/** Просрочен: срок прошёл, документ не исполнен и не выбыл. */
export function isOverdue(
  row: { deadline: string | null; status: string },
  today: string,
): boolean {
  return (
    row.deadline !== null && row.deadline < today && !isDocumentClosed(row.status as DocumentStatus)
  )
}

/**
 * Сводные поля реестра (`objects.meta`): по ним фильтруют и сортируют списки
 * объектов (CollectionView «Документы», сохранённые представления).
 */
export function metaOf(row: {
  typeId: string
  status: string
  regNumber: string | null
  regDate: string | null
  journalId: string | null
  correspondentId: string | null
  authorId: string | null
  responsibleId: string | null
  signerId: string | null
  controllerId: string | null
  deadline: string | null
  control: string
  unitId: string | null
  type: Pick<DocumentTypeRow, 'key' | 'direction'>
}): Record<string, unknown> {
  return {
    typeId: row.typeId,
    typeKey: row.type.key,
    direction: row.type.direction,
    status: row.status,
    closed: isDocumentClosed(row.status as DocumentStatus),
    regNumber: row.regNumber,
    regDate: row.regDate,
    journalId: row.journalId,
    correspondentId: row.correspondentId,
    authorId: row.authorId,
    responsibleId: row.responsibleId,
    signerId: row.signerId,
    controllerId: row.controllerId,
    deadline: row.deadline,
    control: row.control,
    unitId: row.unitId,
  }
}

/** Название документа в реестре: тема, а без темы — название типа. */
function titleOf(subject: string, type: DocumentTypeRow): string {
  return subject.trim() || type.name.ru
}

/** Участники карточки — производные права (участник видит и обсуждает документ). */
function cardParticipants(row: {
  authorId: string | null
  responsibleId: string | null
  signerId: string | null
  controllerId: string | null
}) {
  const entries: Array<{ userId: string; role: keyof typeof CARD_LEVELS; level: Level }> = []
  for (const role of ['author', 'responsible', 'signer', 'controller'] as const) {
    const userId = row[`${role}Id` as const]
    if (userId) entries.push({ userId, role, level: CARD_LEVELS[role] })
  }
  return entries
}

/** Участники — действующие сотрудники. */
async function assertPeople(ids: Array<string | null | undefined>): Promise<void> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return
  const refs = await directory().refs(wanted)
  for (const id of wanted) {
    const ref = refs.get(id)
    if (!ref)
      throw errors.validation('Сотрудник не найден', [{ path: 'responsibleId', message: id }])
    if (ref.status === 'blocked' || ref.status === 'deactivated') {
      throw errors.validation(`Сотрудник «${ref.displayName}» заблокирован`)
    }
  }
}

async function assertReferences(
  executor: Executor,
  input: { correspondentId?: string | null; territoryId?: string | null; unitId?: string | null },
): Promise<void> {
  if (input.correspondentId) {
    const names = await CorrespondentService.names(executor, [input.correspondentId])
    if (!names.has(input.correspondentId)) {
      throw errors.validation('Корреспондент не найден', [
        { path: 'correspondentId', message: 'correspondent' },
      ])
    }
  }
  if (input.territoryId && !(await territoryIndex()).byId.has(input.territoryId)) {
    throw errors.validation('Нет такой территории', [{ path: 'territoryId', message: 'territory' }])
  }
  if (input.unitId && !(await OrgService.briefs([input.unitId])).has(input.unitId)) {
    throw errors.validation('Подразделение не найдено', [{ path: 'unitId', message: 'unit' }])
  }
}

/**
 * Гриф документа — из допустимых типом и не строже допуска автора изменения:
 * иначе документ исчез бы у того, кто его правит (ADR-0080).
 */
function assertConfidentiality(ctx: Ctx, type: DocumentTypeRow, value: Confidentiality): void {
  if (!type.confidentialityAllowed.includes(value)) {
    throw errors.validation('Гриф недоступен для этого типа документа', [
      { path: 'confidentiality', message: 'not_allowed' },
    ])
  }
  const clearance = clearanceOf(ctx)
  if (clearance && !withinClearance(value, clearance)) {
    throw errors.validation('Гриф выше вашего допуска', [
      { path: 'confidentiality', message: 'above_clearance' },
    ])
  }
}

async function emit(
  tx: Executor,
  ctx: Ctx,
  row: { id: string; spaceId: string | null; title: string },
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await publishEvent(tx, ctx, {
    type,
    object: { id: row.id, type: 'document', spaceId: row.spaceId, title: row.title },
    payload,
  })
}

/**
 * Документы (08-documents.md, P3-E02 S01/S03/S06/S11, ADR-0080). Черновик по
 * типу, карточка с проверкой по схеме типа, реквизиты, гриф; статусы меняют
 * только доменные действия — регистрация входящего и аннулирование (остальные
 * переходы — движок процессов второй волны через `applyTransition`).
 */
export const DocumentService = {
  load: loadRow,

  async create(tx: Executor, ctx: Ctx, input: DocumentCreateInput): Promise<string> {
    const authorId = actorId(ctx)
    if (!authorId) throw errors.validation('У документа должен быть автор')
    const type = await DocumentTypeService.load(tx, input.typeId)
    if (!type) throw errors.notFound('Тип документа')
    if (!type.isActive) throw errors.conflict('Тип документа выключен')

    const confidentiality = input.confidentiality ?? type.defaultConfidentiality
    assertConfidentiality(ctx, type, confidentiality)
    await assertPeople([input.responsibleId, input.signerId, input.controllerId])
    await assertReferences(tx, input)
    const fields = validateCardFields(type.cardSchema.fields, input.fields ?? {}, {
      strict: false,
    })

    const card = {
      typeId: type.id,
      status: 'draft',
      regNumber: null,
      regDate: null,
      journalId: null,
      subject: input.subject ?? '',
      summary: input.summary ?? null,
      correspondentId: input.correspondentId ?? null,
      externalNumber: input.externalNumber ?? null,
      externalDate: input.externalDate ?? null,
      receivedDate: input.receivedDate ?? null,
      deliveryMethod: input.deliveryMethod ?? null,
      authorId,
      responsibleId: input.responsibleId ?? null,
      signerId: input.signerId ?? null,
      deadline: input.deadline ?? null,
      control: input.control ?? 'none',
      controllerId: input.controllerId ?? null,
      confidentiality,
      fields,
      territoryId: input.territoryId ?? null,
      unitId:
        input.unitId !== undefined
          ? input.unitId
          : ctx.kind === 'user'
            ? ctx.principals.primaryUnitId
            : null,
    }
    const spaceId = await documentsSpaceId(tx)
    const title = titleOf(card.subject, type)
    const object = await ObjectService.create(tx, ctx, {
      type: 'document',
      spaceId,
      title,
      ownerId: authorId,
      confidentiality,
      meta: metaOf({ ...card, type }),
    })
    await tx.insert(documents).values({ id: object.id, ...card })
    await DocumentParticipants.sync(tx, ctx, object.id, 'card', cardParticipants(card))
    await emit(tx, ctx, { id: object.id, spaceId, title }, 'document.created', {
      typeKey: type.key,
      direction: type.direction,
      status: 'draft',
    })
    await refreshViewers(tx, object.id)
    return object.id
  },

  async get(ctx: UserCtx, id: string): Promise<DocumentRecord> {
    const decision = await authorize(ctx, 'view', id)
    const row = await loadRow(db(), id)
    if (!row) throw errors.notFound('Документ')
    return DocumentService.record(ctx, row, decision.level)
  },

  async record(ctx: UserCtx, row: Row, level: Level): Promise<DocumentRecord> {
    const type = await DocumentTypeService.load(db(), row.typeId)
    if (!type) throw errors.notFound('Тип документа')
    const [
      people,
      correspondents,
      units,
      registration,
      currentVersion,
      versionCount,
      route,
      routes,
    ] = await Promise.all([
      directory().refs(
        [row.authorId, row.responsibleId, row.signerId, row.controllerId].filter(
          (v): v is string => !!v,
        ),
      ),
      CorrespondentService.names(db(), row.correspondentId ? [row.correspondentId] : []),
      OrgService.briefs(row.unitId ? [row.unitId] : []),
      DocumentService.registration(row.id),
      DocumentVersionService.record(db(), row.currentVersionId),
      DocumentVersionService.count(db(), row.id),
      activeRoute(db(), row.id),
      ProcessDefinitions.published(db(), 'document'),
    ])
    const person = (id: string | null): UserRef | null => (id ? (people.get(id) ?? null) : null)
    const status = row.status as DocumentStatus
    const closed = isDocumentClosed(status)
    const allowed = new Set(allowedActions('document', level, ctx, levelValue))
    const canEdit = allowed.has('document.edit') && !closed
    const blocker = routeBlocker({
      canEdit,
      status,
      running: route !== null,
      hasVersion: currentVersion !== null,
    })
    const unit = row.unitId ? units.get(row.unitId) : undefined
    return {
      id: row.id,
      spaceId: row.spaceId ?? '',
      type: {
        id: type.id,
        key: type.key,
        name: type.name,
        direction: type.direction,
        settings: type.settings,
        cardSchema: type.cardSchema,
        confidentialityAllowed: type.confidentialityAllowed,
        journalId: type.numbering.journalId,
      },
      status,
      subject: row.subject,
      summary: row.summary,
      regNumber: row.regNumber,
      regDate: row.regDate,
      registration,
      correspondent: row.correspondentId ? (correspondents.get(row.correspondentId) ?? null) : null,
      externalNumber: row.externalNumber,
      externalDate: row.externalDate,
      receivedDate: row.receivedDate,
      deliveryMethod: row.deliveryMethod as DeliveryMethod | null,
      author: person(row.authorId),
      responsible: person(row.responsibleId),
      signer: person(row.signerId),
      controller: person(row.controllerId),
      deadline: row.deadline,
      control: row.control as DocumentControl,
      overdue: isOverdue(row, todayLocal()),
      confidentiality: parseConfidentiality(row.confidentiality, 'internal'),
      territoryId: row.territoryId,
      unit: unit ? { id: unit.id, name: unit.name.ru } : null,
      fields: row.fields,
      currentVersion,
      versionCount,
      cancelReason: row.cancelReason,
      cancelledAt: row.cancelledAt,
      route,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      version: row.version,
      can: {
        edit: canEdit,
        // Идущий маршрут регистрирует сам — шагом `register`
        register:
          allowed.has('document.register') && canTransition(status, 'registered') && route === null,
        cancel:
          ((status === 'draft' || status === 'returned') && allowed.has('document.cancel')) ||
          (status === 'registered' && allowed.has('document.cancel_registered')),
        // На согласовании и подписи версия заморожена: новая — после возврата
        addVersion:
          allowed.has('document.add_version') && !closed && !ROUTE_ACTIVE_STATUSES.includes(status),
        changeConfidentiality: canEdit,
        share: allowed.has('document.share'),
        startRoute: routes.length > 0 && (blocker === null || blocker === 'no_version'),
      },
    }
  },

  async registration(documentId: string): Promise<DocumentRecord['registration']> {
    const [row] = await db()
      .select({
        journalId: registrations.journalId,
        journalName: journals.name,
        number: registrations.number,
        sequence: registrations.sequence,
        year: registrations.year,
        reserved: registrations.reserved,
        registeredBy: registrations.registeredBy,
        registeredAt: registrations.registeredAt,
      })
      .from(registrations)
      .innerJoin(journals, eq(journals.id, registrations.journalId))
      .where(eq(registrations.documentId, documentId))
      .orderBy(sql`${registrations.registeredAt} desc`)
      .limit(1)
    if (!row) return null
    const people = row.registeredBy ? await directory().refs([row.registeredBy]) : new Map()
    return {
      journalId: row.journalId,
      journalName: row.journalName,
      number: row.number,
      sequence: row.sequence,
      year: row.year,
      reserved: row.reserved,
      registeredAt: row.registeredAt,
      registeredBy: row.registeredBy ? (people.get(row.registeredBy) ?? null) : null,
    }
  },

  /** Правка карточки: реквизиты, поля типа, участники, гриф. */
  async update(tx: Executor, ctx: Ctx, id: string, patch: DocumentUpdateInput): Promise<void> {
    await authorize(ctx, 'edit', id)
    const row = await loadRow(tx, id, true)
    if (!row) throw errors.notFound('Документ')
    if (isDocumentClosed(row.status as DocumentStatus)) {
      throw errors.conflict('Документ закрыт — карточка не меняется')
    }
    const type = await DocumentTypeService.load(tx, row.typeId)
    if (!type) throw errors.notFound('Тип документа')
    await assertPeople([patch.responsibleId, patch.signerId, patch.controllerId])
    await assertReferences(tx, patch)

    const next = {
      subject: patch.subject ?? row.subject,
      summary: patch.summary === undefined ? row.summary : patch.summary,
      correspondentId:
        patch.correspondentId === undefined ? row.correspondentId : patch.correspondentId,
      externalNumber:
        patch.externalNumber === undefined ? row.externalNumber : patch.externalNumber,
      externalDate: patch.externalDate === undefined ? row.externalDate : patch.externalDate,
      receivedDate: patch.receivedDate === undefined ? row.receivedDate : patch.receivedDate,
      deliveryMethod:
        patch.deliveryMethod === undefined ? row.deliveryMethod : patch.deliveryMethod,
      responsibleId: patch.responsibleId === undefined ? row.responsibleId : patch.responsibleId,
      signerId: patch.signerId === undefined ? row.signerId : patch.signerId,
      deadline: patch.deadline === undefined ? row.deadline : patch.deadline,
      control: patch.control ?? row.control,
      controllerId: patch.controllerId === undefined ? row.controllerId : patch.controllerId,
      territoryId: patch.territoryId === undefined ? row.territoryId : patch.territoryId,
      unitId: patch.unitId === undefined ? row.unitId : patch.unitId,
      fields:
        patch.fields === undefined
          ? row.fields
          : validateCardFields(
              type.cardSchema.fields,
              { ...row.fields, ...patch.fields },
              // После регистрации карточка остаётся полной
              { strict: row.status !== 'draft' },
            ),
    }
    const changed = (Object.keys(next) as Array<keyof typeof next>).filter(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(row[key]),
    )
    const confidentiality = patch.confidentiality ?? parseConfidentiality(row.confidentiality)
    const grifChanged = confidentiality !== row.confidentiality
    if (grifChanged) assertConfidentiality(ctx, type, confidentiality)
    if (changed.length === 0 && !grifChanged) return

    if (changed.length > 0) {
      await tx.update(documents).set(next).where(eq(documents.id, id))
      const title = titleOf(next.subject, type)
      // Тема — событие реестра (лента, поиск, вкладки); сводные поля — тихо
      if (title !== row.title) await ObjectService.update(tx, ctx, id, { title })
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: metaOf({ ...row, ...next, type }), mergeMeta: true },
        { silent: true },
      )
      await DocumentParticipants.sync(tx, ctx, id, 'card', cardParticipants({ ...row, ...next }))
      await emit(tx, ctx, { id, spaceId: row.spaceId, title }, 'document.updated', {
        changed: changed.map((key) => (key === 'fields' ? 'fields' : key)),
      })
    }

    if (grifChanged) {
      await tx.update(documents).set({ confidentiality }).where(eq(documents.id, id))
      // Гриф — атрибут доступа ядра: acl.changed пересчитывает поиск, комнаты, датасет
      await ObjectService.setConfidentiality(tx, ctx, id, confidentiality)
      await emit(
        tx,
        ctx,
        { id, spaceId: row.spaceId, title: row.title },
        'document.confidentiality_changed',
        { from: row.confidentiality, to: confidentiality },
      )
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.documentConfidentialityChanged,
          objectId: id,
          objectType: 'document',
          severity: 'notice',
          details: { from: row.confidentiality, to: confidentiality },
        },
        tx,
      )
      await refreshViewers(tx, id)
    }
  },

  /**
   * Регистрация (08-documents.md §5): реквизиты и поля типа заполнены, скан на
   * месте (правило типа), номер из журнала — в транзакции с блокировкой
   * счётчика или из резерва; документ ложится в журнал (его делопроизводители
   * видят документ по наследованию) и становится `registered`.
   */
  async register(
    tx: Executor,
    ctx: Ctx,
    id: string,
    input: DocumentRegisterInput,
    options: { viaRoute?: boolean } = {},
  ): Promise<string> {
    if (options.viaRoute && ctx.kind === 'user') {
      // Регистратор шага маршрута: назначение проверил движок, право правки документа
      // ему не нужно — достаточно способности и права регистрировать в журнале
      if (!hasCapability(ctx, 'documents.register')) {
        throw errors.forbidden('Требуется способность', { capability: 'documents.register' })
      }
    } else {
      await authorize(ctx, 'register', id)
    }
    const row = await loadRow(tx, id, true)
    if (!row) throw errors.notFound('Документ')
    const status = row.status as DocumentStatus
    if (!canTransition(status, 'registered')) {
      throw errors.conflict('Документ в этом статусе не регистрируется', { status })
    }
    // Документ на маршруте регистрирует шаг `register` маршрута, а не карточка
    if (!options.viaRoute && (await ProcessService.running(tx, id)).length > 0) {
      throw errors.conflict('Документ регистрируется по маршруту', { reason: 'route_running' })
    }
    const type = await DocumentTypeService.load(tx, row.typeId)
    if (!type) throw errors.notFound('Тип документа')

    let journalId = input.journalId ?? type.numbering.journalId
    if (input.reservationId && !input.journalId) {
      const reserved = await JournalService.reservationRecords(tx, [input.reservationId])
      journalId = reserved[0]?.journalId ?? journalId
    }
    if (!journalId) {
      throw errors.validation('У типа документа нет журнала — выберите журнал', [
        { path: 'journalId', message: 'required' },
      ])
    }
    const journal = await JournalService.load(tx, journalId)
    if (!journal) throw errors.notFound('Журнал')
    if (!journal.isActive) throw errors.conflict('Журнал закрыт для регистрации')
    if (journal.typeIds.length > 0 && !journal.typeIds.includes(type.id)) {
      throw errors.validation('Журнал не принимает документы этого типа', [
        { path: 'journalId', message: 'type' },
      ])
    }
    // Регистрирует делопроизводитель журнала: право на журнал и способность
    await authorize(ctx, 'register_in', journalId)

    assertRequisites(type.direction, row)
    validateCardFields(type.cardSchema.fields, row.fields, { strict: true })
    if (type.settings.requireScan) {
      const version = await DocumentVersionService.record(tx, row.currentVersionId)
      if (!version?.mainFile) {
        throw errors.validation('Приложите скан документа', [
          { path: 'currentVersion', message: 'scan_required' },
        ])
      }
    }

    const date = todayLocal()
    const issued = await JournalService.issue(tx, journal, {
      date,
      format: type.numbering.format,
      unitId: row.unitId,
      ...(input.reservationId ? { reservationId: input.reservationId } : {}),
    })
    if (issued.reservationId) await JournalService.useReservation(tx, issued.reservationId, id)
    await tx.insert(registrations).values({
      id: newId(),
      documentId: id,
      journalId,
      number: issued.number,
      sequence: issued.sequence,
      year: issued.year,
      reserved: issued.reservationId !== null,
      registeredBy: actorId(ctx),
    })

    const deadline =
      row.deadline ??
      (type.settings.defaultDeadlineDays
        ? await BusinessCalendar.addWorkingDays(date, type.settings.defaultDeadlineDays)
        : null)
    const control =
      row.control === 'none' && type.settings.autoControl && deadline ? 'on' : row.control
    await tx
      .update(documents)
      .set({ regNumber: issued.number, regDate: date, journalId, deadline, control })
      .where(eq(documents.id, id))
    await applyTransition(tx, ctx, id, { to: 'registered', cause: 'register' })

    // Документ — в журнале: делопроизводители журнала видят его по наследованию
    await ObjectService.move(tx, ctx, id, { parentId: journalId }, { silent: true })
    await ObjectService.update(
      tx,
      ctx,
      id,
      {
        subtitle: issued.number,
        meta: metaOf({
          ...row,
          status: 'registered',
          regNumber: issued.number,
          regDate: date,
          journalId,
          deadline,
          control,
          type,
        }),
        mergeMeta: true,
      },
      { silent: true },
    )
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: row.title }, 'document.registered', {
      number: issued.number,
      journalId,
      sequence: issued.sequence,
      year: issued.year,
      reserved: issued.reservationId !== null,
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.documentRegistered,
        objectId: id,
        objectType: 'document',
        details: { number: issued.number, journalId, reserved: issued.reservationId !== null },
      },
      tx,
    )
    await refreshViewers(tx, id)
    return issued.number
  },

  /**
   * Аннулирование (08-documents.md §3): черновик — правом правки,
   * зарегистрированный — ещё и способностью делопроизводителя; всегда с
   * обоснованием, в аудит. Дела Входящих по документу закрываются.
   */
  async cancel(tx: Executor, ctx: Ctx, id: string, input: DocumentCancelInput): Promise<void> {
    await authorize(ctx, 'view', id)
    const row = await loadRow(tx, id, true)
    if (!row) throw errors.notFound('Документ')
    const status = row.status as DocumentStatus
    await authorize(ctx, status === 'registered' ? 'cancel_registered' : 'cancel', id)
    if (!canTransition(status, 'cancelled')) {
      throw errors.conflict('Документ в этом статусе не аннулируется', { status })
    }
    // Возвращённый документ ждёт доработки по маршруту: аннулирование его отзывает
    const system = systemCtx('documents.cancel', { initiatorId: actorId(ctx) })
    for (const route of await ProcessService.running(tx, id)) {
      await ProcessService.cancel(tx, system, {
        instanceId: route.instanceId,
        reason: input.reason,
        outcome: 'withdrawn',
      })
    }
    await tx.update(documents).set({ cancelReason: input.reason }).where(eq(documents.id, id))
    await applyTransition(tx, ctx, id, { to: 'cancelled', cause: 'cancel' })
    await emit(tx, ctx, { id, spaceId: row.spaceId, title: row.title }, 'document.cancelled', {
      from: status,
      reason: input.reason,
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.documentCancelled,
        objectId: id,
        objectType: 'document',
        severity: 'notice',
        details: { from: status, reason: input.reason, number: row.regNumber },
      },
      tx,
    )
    await InboxService.resolve(tx, ctx, { objectId: id }, 'dismissed')
  },

  /** Счётчики навигатора: мои, на контроле, просроченные, черновики. */
  async summary(ctx: UserCtx): Promise<DocumentSummary> {
    const me = ctx.userId
    const today = todayLocal()
    const open = sql`${documents.status} NOT IN ('executed', 'filed', 'archived', 'cancelled')`
    const [row] = await db()
      .select({
        mine: sql<number>`count(*) FILTER (WHERE ${open} AND (${documents.responsibleId} = ${me} OR ${documents.authorId} = ${me} OR ${documents.signerId} = ${me} OR ${documents.controllerId} = ${me}))::int`,
        onControl: sql<number>`count(*) FILTER (WHERE ${open} AND ${documents.control} = 'on')::int`,
        overdue: sql<number>`count(*) FILTER (WHERE ${open} AND ${documents.deadline} < ${today}::date)::int`,
        drafts: sql<number>`count(*) FILTER (WHERE ${documents.status} = 'draft' AND ${documents.authorId} = ${me})::int`,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .where(and(visibleObjectsSql(ctx, 'document'), sql`${objects.deletedAt} IS NULL`))
    return {
      mine: row?.mine ?? 0,
      onControl: row?.onControl ?? 0,
      overdue: row?.overdue ?? 0,
      drafts: row?.drafts ?? 0,
    }
  },
}
