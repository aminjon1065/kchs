import {
  type DocumentResolutions,
  type DocumentStatus,
  type NoExecutionInput,
  parseConfidentiality,
  type ResolutionInput,
  type ResolutionRecord,
  type ResolutionRequestInput,
  type ResolutionRequestRecord,
  type ResolutionRequestState,
  type UserRef,
} from '@kchs/contracts'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { clearedUsers } from '~/kernel/access/confidentiality.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { BusinessCalendar } from '~/kernel/business-calendar/service.js'
import { endOfLocalDay } from '~/kernel/business-calendar/working-days.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { delegationCovers, InboxService } from '~/kernel/inbox/service.js'
import { OrgService } from '~/modules/identity/public.js'
import { Instructions } from '~/modules/tasks/public.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { resolutionRequests, resolutions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { DocumentService } from './document-service.js'
import { todayLocal } from './journal-service.js'
import { applyTransition } from './lifecycle.js'
import { DocumentParticipants } from './participants.js'
import { DocumentTypeService } from './type-service.js'

/** Резолюции накладываются на зарегистрированный документ и на исполнении (вложенные, новые). */
const RESOLVABLE: readonly DocumentStatus[] = ['registered', 'on_execution']

/** Источник участия получателей направлений: читают и обсуждают документ до резолюции. */
const REQUEST_SOURCE = 'resolution_request'

type Row = typeof resolutions.$inferSelect
type RequestRow = typeof resolutionRequests.$inferSelect
type DocumentRow = NonNullable<Awaited<ReturnType<typeof DocumentService.load>>>

const unique = (ids: Iterable<string>) => [...new Set(ids)]

/** Сотрудник, за которого действует пользователь в делах документов (замещение). */
function actsFor(ctx: UserCtx, userId: string): boolean {
  return ctx.principals.actingFor.some(
    (item) => item.userId === userId && delegationCovers('resolve', item.scope),
  )
}

/** Название поручения по резолюции: первая строка текста, не длиннее 200 символов. */
function instructionTitle(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** Срок резолюции: дата — конец дня в поясе установки; рабочие дни — по календарю. */
async function resolveDue(
  tx: Executor,
  input: Pick<ResolutionInput, 'dueDate' | 'dueWorkingDays'>,
): Promise<{ date: string; dueAt: string; workingDays: number | null }> {
  if (input.dueWorkingDays !== undefined) {
    const { date, dueAt } = await BusinessCalendar.deadline(new Date(), input.dueWorkingDays, {
      executor: tx,
    })
    return { date, dueAt: dueAt.toISOString(), workingDays: input.dueWorkingDays }
  }
  const date = input.dueDate ?? todayLocal()
  if (date < todayLocal()) {
    throw errors.validation('Срок резолюции уже прошёл', [
      { path: 'dueDate', message: 'Срок в прошлом' },
    ])
  }
  return { date, dueAt: endOfLocalDay(date, config().TZ).toISOString(), workingDays: null }
}

async function openRequestOf(
  executor: Executor,
  documentId: string,
  userId: string,
): Promise<RequestRow | null> {
  const [row] = await executor
    .select()
    .from(resolutionRequests)
    .where(
      and(
        eq(resolutionRequests.documentId, documentId),
        eq(resolutionRequests.userId, userId),
        eq(resolutionRequests.state, 'open'),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Открытые направления: закрыть с итогом и снять дела Входящих их получателей. */
async function closeRequests(
  tx: Executor,
  ctx: Ctx,
  documentId: string,
  close: { userId?: string; state: ResolutionRequestState; comment?: string | null },
): Promise<string[]> {
  const conditions = [
    eq(resolutionRequests.documentId, documentId),
    eq(resolutionRequests.state, 'open'),
  ]
  if (close.userId) conditions.push(eq(resolutionRequests.userId, close.userId))
  const closed = await tx
    .update(resolutionRequests)
    .set({ state: close.state, closedAt: sql`now()`, comment: close.comment ?? null })
    .where(and(...conditions))
    .returning({ userId: resolutionRequests.userId })
  for (const { userId } of closed) {
    await InboxService.resolve(
      tx,
      ctx,
      { objectId: documentId, kind: 'resolve', userId },
      close.state === 'resolved' || close.state === 'no_execution' ? 'resolved' : 'dismissed',
      close.state,
    )
  }
  return closed.map((row) => row.userId)
}

/** Получатели направлений (кроме снятых) читают и обсуждают документ. */
async function syncRequestParticipants(tx: Executor, ctx: Ctx, documentId: string) {
  const rows = await tx
    .selectDistinct({ userId: resolutionRequests.userId })
    .from(resolutionRequests)
    .where(
      and(eq(resolutionRequests.documentId, documentId), ne(resolutionRequests.state, 'cancelled')),
    )
  await DocumentParticipants.sync(
    tx,
    ctx,
    documentId,
    REQUEST_SOURCE,
    rows.map((row) => ({
      userId: row.userId,
      role: 'resolution' as const,
      level: 'comment' as const,
    })),
  )
}

/** Все, кого резолюция делает участниками документа: автор, исполнители, контролёр. */
function resolutionParticipants(row: {
  authorId: string
  responsibleId: string
  coExecutors: string[]
  controllerId: string | null
}) {
  return unique([
    row.authorId,
    row.responsibleId,
    ...row.coExecutors,
    ...(row.controllerId ? [row.controllerId] : []),
  ]).map((userId) => ({ userId, role: 'resolution' as const, level: 'comment' as const }))
}

/** Исполнители — действующие сотрудники с допуском к грифу документа. */
async function assertExecutors(
  tx: Executor,
  document: DocumentRow,
  people: string[],
): Promise<void> {
  const active = await directory().activeUsers(people)
  if (active.length !== people.length) {
    throw errors.validation('Среди исполнителей есть отключённые сотрудники', [
      { path: 'responsibleId', message: 'inactive' },
    ])
  }
  const grif = parseConfidentiality(document.confidentiality, 'internal')
  const cleared = new Set(await clearedUsers(people, grif, tx))
  const denied = people.filter((id) => !cleared.has(id))
  if (denied.length > 0) {
    const refs = await directory().refs(denied)
    const names = denied.map((id) => refs.get(id)?.displayName ?? id).join(', ')
    throw errors.validation(`Нет допуска к грифу документа: ${names}`, [
      { path: 'responsibleId', message: 'clearance' },
    ])
  }
}

/**
 * Руководитель подразделения документа, а без него — ближайший вышестоящий
 * (правило типа `unit_head`, ADR-0084).
 */
async function unitHeadFor(unitId: string | null): Promise<string | null> {
  if (!unitId) return null
  const units = new Map((await OrgService.tree()).map((unit) => [unit.id, unit]))
  let current = units.get(unitId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.isActive && current.head?.id) return current.head.id
    current = current.parentId ? units.get(current.parentId) : undefined
  }
  return null
}

function eventObject(document: DocumentRow) {
  return { id: document.id, type: 'document', spaceId: document.spaceId, title: document.title }
}

/**
 * Резолюции и исполнение документа (08-documents.md §6, ADR-0084).
 *
 * - Направление на резолюцию — правилом типа после регистрации или вручную
 *   (делопроизводитель; получатель может переадресовать): дело Входящих
 *   `resolve`, право читать и обсуждать документ.
 * - Резолюция в одной транзакции: запись, поручения ответственному и
 *   соисполнителям (`Instructions.create`), права исполнителей, закрытие
 *   направления, переход `registered → on_execution`, контроль документа.
 *   Вносит её получатель направления, его заместитель или делопроизводитель
 *   от имени руководителя; вложенную — ответственный или соисполнитель.
 * - «Не требует исполнения» — `registered → executed` без поручений.
 * - Исполнение: закрытие последнего поручения документа (`task.source_closed`)
 *   переводит его в `executed` — подписчик модуля.
 */
export const ResolutionService = {
  async create(tx: Executor, ctx: UserCtx, documentId: string, input: ResolutionInput) {
    await authorize(ctx, 'view', documentId)
    const document = await DocumentService.load(tx, documentId, true)
    if (!document) throw errors.notFound('Документ')
    const type = await DocumentTypeService.load(tx, document.typeId)
    if (!type) throw errors.notFound('Тип документа')
    if (!type.settings.allowResolutions) {
      throw errors.conflict('Для этого типа документа резолюции не предусмотрены')
    }
    if (!RESOLVABLE.includes(document.status as DocumentStatus)) {
      throw errors.conflict('Резолюция накладывается на зарегистрированный документ', {
        status: document.status,
      })
    }

    const principal = ctx.onBehalfOf ?? ctx.userId
    const registrar = (await authorize(ctx, 'register', documentId, { soft: true })).allowed
    let authorId = principal
    if (input.authorId && input.authorId !== principal) {
      if (!actsFor(ctx, input.authorId) && !registrar) {
        throw errors.forbidden(
          'Внести резолюцию от имени руководителя может делопроизводитель или заместитель',
        )
      }
      authorId = input.authorId
    }
    const enteredBy = authorId !== ctx.userId ? ctx.userId : null
    if ((await directory().activeUsers([authorId])).length === 0) {
      throw errors.validation('Автор резолюции отключён', [
        { path: 'authorId', message: 'inactive' },
      ])
    }

    let parent: Row | null = null
    if (input.parentId) {
      const [found] = await tx
        .select()
        .from(resolutions)
        .where(and(eq(resolutions.id, input.parentId), eq(resolutions.documentId, documentId)))
        .limit(1)
      if (!found) throw errors.notFound('Резолюция')
      if (found.responsibleId !== authorId && !found.coExecutors.includes(authorId)) {
        throw errors.forbidden('Вложенную резолюцию пишет ответственный или соисполнитель')
      }
      parent = found
    } else if (!(await openRequestOf(tx, documentId, authorId)) && !(registrar && enteredBy)) {
      throw errors.forbidden('Документ не направлен вам на резолюцию')
    }

    const executors = unique([input.responsibleId, ...input.coExecutorIds])
    await assertExecutors(tx, document, executors)
    const registration = await DocumentService.registration(documentId)
    let controllerId: string | null = null
    if (input.control) {
      controllerId =
        input.controllerId !== undefined
          ? input.controllerId
          : (document.controllerId ?? registration?.registeredBy?.id ?? null)
      // Ответственный себя не контролирует; автор принимает отчёты и так
      if (controllerId === input.responsibleId || controllerId === authorId) controllerId = null
      if (controllerId) await assertExecutors(tx, document, [controllerId])
    }

    const due = await resolveDue(tx, input)
    if (parent && due.date > parent.deadline) {
      throw errors.validation('Срок вложенной резолюции — не позже срока родительской', [
        { path: 'dueDate', message: 'after_parent' },
      ])
    }

    const id = newId()
    await tx.insert(resolutions).values({
      id,
      documentId,
      parentId: parent?.id ?? null,
      authorId,
      enteredBy,
      text: input.text,
      responsibleId: input.responsibleId,
      coExecutors: input.coExecutorIds,
      deadline: due.date,
      dueWorkingDays: due.workingDays,
      control: input.control,
      controllerId,
    })

    const grif = parseConfidentiality(document.confidentiality, 'internal')
    const created = await Instructions.create(tx, ctx, {
      title: instructionTitle(input.text),
      description: input.text,
      source: {
        kind: 'resolution',
        objectId: documentId,
        resolutionId: id,
        label: document.regNumber,
      },
      authorId,
      assigneeId: input.responsibleId,
      coAssigneeIds: input.coExecutorIds,
      controllerId,
      due: due.workingDays !== null ? { workingDays: due.workingDays } : { at: due.dueAt },
      // Пространство — документа (по источнику): права исполнителей — участием в поручении
      ...(grif !== 'public' ? { confidentiality: grif } : {}),
    })
    const instructionIds = [created.id, ...created.parts.map((part) => part.id)]
    await tx.update(resolutions).set({ instructionIds }).where(eq(resolutions.id, id))

    await DocumentParticipants.sync(
      tx,
      ctx,
      documentId,
      `resolution:${id}`,
      resolutionParticipants({
        authorId,
        responsibleId: input.responsibleId,
        coExecutors: input.coExecutorIds,
        controllerId,
      }),
    )
    if (!parent) await closeRequests(tx, ctx, documentId, { userId: authorId, state: 'resolved' })
    if (document.status === 'registered') {
      await applyTransition(tx, ctx, documentId, {
        to: 'on_execution',
        cause: 'resolution',
        source: { kind: 'resolution', id },
      })
    }
    // Контроль документа — по первой резолюции на контроле: срок и контролёр карточки
    if (input.control && !parent) {
      await DocumentService.applyExecutionControl(tx, ctx, documentId, {
        control: 'on',
        ...(document.deadline ? {} : { deadline: due.date }),
        ...(document.controllerId || !controllerId ? {} : { controllerId }),
      })
    }

    await publishEvent(tx, ctx, {
      type: 'document.resolution_added',
      object: eventObject(document),
      payload: {
        resolutionId: id,
        parentId: parent?.id ?? null,
        authorId,
        responsibleId: input.responsibleId,
        coExecutorIds: input.coExecutorIds,
        controllerId,
        dueDate: due.date,
        instructionIds,
      },
    })
    if (enteredBy) {
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.resolutionAdded,
          objectId: documentId,
          objectType: 'document',
          details: { resolutionId: id, authorId, enteredBy },
        },
        tx,
      )
    }
    return id
  },

  /**
   * Направить на резолюцию: делопроизводитель — любому сотруднику с допуском;
   * получатель направления — переадресовать (его направление закрывается).
   * `auto` — правило типа при регистрации (права проверила регистрация).
   */
  async request(
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: ResolutionRequestInput,
    options: { auto?: boolean } = {},
  ): Promise<string> {
    if (!options.auto) await authorize(ctx, 'view', documentId)
    const document = await DocumentService.load(tx, documentId, true)
    if (!document) throw errors.notFound('Документ')
    const type = await DocumentTypeService.load(tx, document.typeId)
    if (!type?.settings.allowResolutions) {
      throw errors.conflict('Для этого типа документа резолюции не предусмотрены')
    }
    if (!RESOLVABLE.includes(document.status as DocumentStatus)) {
      throw errors.conflict('На резолюцию направляется зарегистрированный документ', {
        status: document.status,
      })
    }

    let forwardedFrom: string | null = null
    if (!options.auto && ctx.kind === 'user') {
      const principal = ctx.onBehalfOf ?? ctx.userId
      const registrar = (await authorize(ctx, 'register', documentId, { soft: true })).allowed
      const own = await openRequestOf(tx, documentId, principal)
      if (!registrar && !own) {
        throw errors.forbidden(
          'Направить на резолюцию может делопроизводитель или тот, кому документ направлен',
        )
      }
      if (own && !registrar) forwardedFrom = principal
      if (forwardedFrom === input.userId) {
        throw errors.validation('Документ уже направлен вам', [{ path: 'userId', message: 'self' }])
      }
    }
    await assertExecutors(tx, document, [input.userId])
    const existing = await openRequestOf(tx, documentId, input.userId)
    if (existing) {
      if (options.auto) return existing.id
      throw errors.conflict('Документ уже направлен этому сотруднику на резолюцию')
    }

    const id = newId()
    await tx.insert(resolutionRequests).values({
      id,
      documentId,
      userId: input.userId,
      requestedBy: ctx.kind === 'user' ? ctx.userId : ctx.initiatorId,
      dueDate: input.dueDate,
      note: input.note,
    })
    await syncRequestParticipants(tx, ctx, documentId)
    await InboxService.open(tx, ctx, {
      userId: input.userId,
      kind: 'resolve',
      objectId: documentId,
      // Название — сводка объекта (с грифом — без содержания); примечание — в карточке
      titleKey: 'inbox.tpl.resolveDocument',
      dueAt: input.dueDate ? endOfLocalDay(input.dueDate, config().TZ).toISOString() : null,
      dedupeKey: `resolve:${documentId}`,
      actions: [
        {
          key: 'resolve',
          labelKey: 'inbox.actions.writeResolution',
          variant: 'primary',
          requiresComment: false,
          openObject: true,
        },
        {
          key: 'no_execution',
          labelKey: 'inbox.actions.noExecution',
          variant: 'secondary',
          requiresComment: false,
        },
      ],
    })
    if (forwardedFrom) {
      await closeRequests(tx, ctx, documentId, {
        userId: forwardedFrom,
        state: 'forwarded',
        comment: input.note,
      })
    }
    await publishEvent(tx, ctx, {
      type: 'document.resolution_requested',
      object: eventObject(document),
      payload: {
        requestId: id,
        userId: input.userId,
        auto: Boolean(options.auto),
        forwardedFrom,
      },
    })
    return id
  },

  /** Направление правилом типа после регистрации (ADR-0084): получатель — по правилу. */
  async requestByTypeRule(tx: Executor, ctx: Ctx, documentId: string): Promise<string | null> {
    const document = await DocumentService.load(tx, documentId)
    if (!document) return null
    const type = await DocumentTypeService.load(tx, document.typeId)
    if (!type?.settings.allowResolutions) return null
    const target =
      type.settings.resolutionBy === 'user'
        ? type.settings.resolutionUserId
        : type.settings.resolutionBy === 'unit_head'
          ? await unitHeadFor(document.unitId)
          : null
    if (!target) return null
    if ((await directory().activeUsers([target])).length === 0) return null
    const grif = parseConfidentiality(document.confidentiality, 'internal')
    if ((await clearedUsers([target], grif, tx)).length === 0) return null
    return ResolutionService.request(
      tx,
      ctx,
      documentId,
      { userId: target, dueDate: null, note: null },
      { auto: true },
    )
  },

  /** Снять направление (делопроизводитель): получатель больше не ждёт резолюции. */
  async cancelRequest(tx: Executor, ctx: UserCtx, documentId: string, requestId: string) {
    await authorize(ctx, 'register', documentId)
    const [row] = await tx
      .select()
      .from(resolutionRequests)
      .where(
        and(eq(resolutionRequests.id, requestId), eq(resolutionRequests.documentId, documentId)),
      )
      .limit(1)
    if (!row) throw errors.notFound('Направление на резолюцию')
    if (row.state !== 'open') throw errors.conflict('Направление уже закрыто')
    await closeRequests(tx, ctx, documentId, { userId: row.userId, state: 'cancelled' })
    await syncRequestParticipants(tx, ctx, documentId)
  },

  /**
   * «Не требует исполнения»: получатель направления (или его заместитель) либо
   * делопроизводитель; документ зарегистрирован и без резолюций.
   */
  async noExecution(tx: Executor, ctx: UserCtx, documentId: string, input: NoExecutionInput) {
    await authorize(ctx, 'view', documentId)
    const document = await DocumentService.load(tx, documentId, true)
    if (!document) throw errors.notFound('Документ')
    if (document.status !== 'registered') {
      throw errors.conflict('«Не требует исполнения» — только для зарегистрированного документа', {
        status: document.status,
      })
    }
    const principal = ctx.onBehalfOf ?? ctx.userId
    const own = await openRequestOf(tx, documentId, principal)
    const registrar = (await authorize(ctx, 'register', documentId, { soft: true })).allowed
    if (!own && !registrar) {
      throw errors.forbidden('Решить может тот, кому документ направлен, или делопроизводитель')
    }
    const [resolved] = await tx
      .select({ id: resolutions.id })
      .from(resolutions)
      .where(eq(resolutions.documentId, documentId))
      .limit(1)
    if (resolved) throw errors.conflict('По документу уже есть резолюции')

    await closeRequests(tx, ctx, documentId, { state: 'no_execution', comment: input.comment })
    await applyTransition(tx, ctx, documentId, {
      to: 'executed',
      cause: 'no_execution',
      ...(own ? { source: { kind: 'resolution_request', id: own.id } } : {}),
    })
    if (document.control === 'on') {
      await DocumentService.applyExecutionControl(tx, ctx, documentId, { control: 'done' })
    }
  },

  /**
   * Исполнение (подписчик `task.source_closed`): все поручения документа
   * закрыты — документ на исполнении становится «Исполнен», контроль снимается.
   */
  async executed(tx: Executor, ctx: Ctx, documentId: string, resolutionIds: string[]) {
    const document = await DocumentService.load(tx, documentId, true)
    if (document?.status !== 'on_execution') return false
    const status = await Instructions.status(documentId, tx)
    if (!status.allClosed) return false
    await applyTransition(tx, ctx, documentId, {
      to: 'executed',
      cause: 'execution',
      ...(resolutionIds[0] ? { source: { kind: 'resolution', id: resolutionIds[0] } } : {}),
    })
    if (document.control === 'on') {
      await DocumentService.applyExecutionControl(tx, ctx, documentId, { control: 'done' })
    }
    return true
  },

  /**
   * Документ аннулирован или закрыт (исполнен, подшит, в архиве) — открытые
   * направления снимаются: резолюцию на него уже не наложить, а дело Входящих
   * получателя вело бы в тупик.
   */
  async documentClosed(tx: Executor, ctx: Ctx, documentId: string) {
    await closeRequests(tx, ctx, documentId, { state: 'cancelled' })
  },

  /** Вкладка «Резолюции и поручения»: дерево, направления, права смотрящего. */
  async list(ctx: UserCtx, documentId: string): Promise<DocumentResolutions> {
    await authorize(ctx, 'view', documentId)
    const document = await DocumentService.load(db(), documentId)
    if (!document) throw errors.notFound('Документ')
    const type = await DocumentTypeService.load(db(), document.typeId)
    const [rows, requests, instructions, registrar] = await Promise.all([
      db()
        .select()
        .from(resolutions)
        .where(eq(resolutions.documentId, documentId))
        .orderBy(asc(resolutions.createdAt)),
      db()
        .select()
        .from(resolutionRequests)
        .where(eq(resolutionRequests.documentId, documentId))
        .orderBy(asc(resolutionRequests.requestedAt)),
      Instructions.bySource(ctx, documentId),
      authorize(ctx, 'register', documentId, { soft: true }),
    ])
    const progress = await Promise.all(rows.map((row) => Instructions.progress(row.instructionIds)))
    const people = await directory().refs(
      unique([
        ...rows.flatMap((row) => [
          row.authorId,
          row.responsibleId,
          ...row.coExecutors,
          ...(row.enteredBy ? [row.enteredBy] : []),
          ...(row.controllerId ? [row.controllerId] : []),
        ]),
        ...requests.flatMap((row) => [row.userId, ...(row.requestedBy ? [row.requestedBy] : [])]),
      ]),
    )
    const person = (id: string | null): UserRef | null => (id ? (people.get(id) ?? null) : null)
    const me = ctx.onBehalfOf ?? ctx.userId
    const mine = (userId: string) => userId === me || actsFor(ctx, userId)
    const allowed = Boolean(type?.settings.allowResolutions)
    const open = RESOLVABLE.includes(document.status as DocumentStatus) && allowed
    const byId = new Map(instructions.map((item) => [item.id, item]))

    const items: ResolutionRecord[] = rows.flatMap((row, index) => {
      const author = person(row.authorId)
      const responsible = person(row.responsibleId)
      if (!author || !responsible) return []
      return [
        {
          id: row.id,
          documentId,
          parentId: row.parentId,
          author,
          enteredBy: person(row.enteredBy),
          text: row.text,
          responsible,
          coExecutors: row.coExecutors.flatMap((id) => person(id) ?? []),
          dueDate: row.deadline,
          dueWorkingDays: row.dueWorkingDays,
          control: row.control,
          controller: person(row.controllerId),
          createdAt: row.createdAt,
          instructions: row.instructionIds.flatMap((id) => byId.get(id) ?? []),
          total: progress[index]?.total ?? 0,
          open: progress[index]?.open ?? 0,
          canNest: open && [row.responsibleId, ...row.coExecutors].some(mine),
        },
      ]
    })
    const records: ResolutionRequestRecord[] = requests.flatMap((row) => {
      const user = person(row.userId)
      if (!user) return []
      return [
        {
          id: row.id,
          user,
          requestedBy: person(row.requestedBy),
          requestedAt: row.requestedAt,
          dueDate: row.dueDate,
          note: row.note,
          state: row.state as ResolutionRequestState,
          closedAt: row.closedAt,
          comment: row.comment,
        },
      ]
    })
    const openRequests = requests.filter((row) => row.state === 'open')
    const ownRequest = openRequests.find((row) => mine(row.userId)) ?? null
    return {
      items,
      requests: records,
      can: {
        resolve: open && ownRequest !== null,
        resolveOnBehalf: open && registrar.allowed,
        request: open && (registrar.allowed || ownRequest !== null),
        noExecution:
          document.status === 'registered' &&
          rows.length === 0 &&
          (registrar.allowed || ownRequest !== null),
      },
      defaultAuthor: ownRequest ? person(ownRequest.userId) : null,
    }
  },
}
