import {
  type CorrespondenceChain,
  type CorrespondenceItem,
  type DeliveryMethod,
  type DocumentDirection,
  type DocumentDispatch,
  type DocumentDispatchInput,
  type DocumentReplyInput,
  type DocumentStatus,
  parseConfidentiality,
  withinClearance,
} from '@kchs/contracts'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { clearanceOf } from '~/kernel/access/confidentiality.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { documentDispatches, documents, documentTypes, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { CorrespondentService } from './correspondent-service.js'
import { DocumentService } from './document-service.js'
import { applyTransition } from './lifecycle.js'
import { DocumentTypeService } from './type-service.js'

/** На какие документы отвечают: зарегистрированный входящий, пока он не в деле. */
export const REPLYABLE_STATUSES: readonly DocumentStatus[] = [
  'registered',
  'on_execution',
  'executed',
]

/** Отправка отмечается у зарегистрированного исходящего — и повторно у исполненного. */
export const DISPATCHABLE_STATUSES: readonly DocumentStatus[] = ['registered', 'executed']

/** Сколько документов показывает цепочка переписки. */
const CHAIN_LIMIT = 50

/** Исходящий тип для ответа: заданный, иначе «Исходящее письмо», иначе первый исходящий. */
async function replyType(executor: Executor, typeId: string | undefined) {
  if (typeId) {
    const type = await DocumentTypeService.load(executor, typeId)
    if (type?.direction !== 'outgoing' || !type.isActive) {
      throw errors.validation('Ответ готовится исходящим документом', [
        { path: 'typeId', message: 'not_outgoing' },
      ])
    }
    return type
  }
  const letter = await DocumentTypeService.byKey(executor, 'outgoing_letter')
  if (letter?.isActive && letter.direction === 'outgoing') return letter
  const [first] = await executor
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .innerJoin(objects, eq(objects.id, documentTypes.id))
    .where(
      and(
        eq(documentTypes.direction, 'outgoing'),
        eq(documentTypes.isActive, true),
        sql`${objects.deletedAt} IS NULL`,
      ),
    )
    .orderBy(asc(documentTypes.key))
    .limit(1)
  const type = first ? await DocumentTypeService.load(executor, first.id) : null
  if (!type) throw errors.conflict('Нет действующего типа исходящих документов')
  return type
}

async function directionOf(executor: Executor, typeId: string): Promise<DocumentDirection> {
  const type = await DocumentTypeService.load(executor, typeId)
  if (!type) throw errors.notFound('Тип документа')
  return type.direction
}

/**
 * Переписка (08-documents.md §5, §11, ADR-0086): ответ на входящий одним
 * действием, отметки об отправке исходящего (реестр отправки) и цепочка
 * документов по связям «в ответ на».
 */
export const Correspondence = {
  /**
   * Исходящий-ответ: черновик наследует корреспондента, подразделение и гриф
   * входящего и связывается с ним `reply_to` — в той же транзакции.
   */
  async reply(tx: Executor, ctx: UserCtx, sourceId: string, input: DocumentReplyInput) {
    await authorize(ctx, 'reply', sourceId)
    const source = await DocumentService.load(tx, sourceId)
    if (!source) throw errors.notFound('Документ')
    if ((await directionOf(tx, source.typeId)) !== 'incoming') {
      throw errors.conflict('Ответ готовится на входящий документ')
    }
    if (!REPLYABLE_STATUSES.includes(source.status as DocumentStatus)) {
      throw errors.conflict('Ответить можно на зарегистрированный входящий документ', {
        status: source.status,
      })
    }
    const type = await replyType(tx, input.typeId)
    // Гриф входящего — если тип ответа его допускает и он не выше допуска автора
    const grif = parseConfidentiality(source.confidentiality, 'internal')
    const clearance = clearanceOf(ctx)
    const inherited =
      type.confidentialityAllowed.includes(grif) && (!clearance || withinClearance(grif, clearance))
    const addresseeField = type.cardSchema.fields.some((field) => field.key === 'addressee')
    const correspondent = source.correspondentId
      ? (await CorrespondentService.names(tx, [source.correspondentId])).get(source.correspondentId)
      : undefined
    const id = await DocumentService.create(tx, ctx, {
      typeId: type.id,
      subject: source.subject,
      correspondentId: source.correspondentId,
      unitId: ctx.principals.primaryUnitId ?? source.unitId,
      ...(inherited ? { confidentiality: grif } : {}),
      ...(addresseeField && correspondent ? { fields: { addressee: correspondent.name } } : {}),
    })
    await LinkService.link(tx, ctx, id, sourceId, 'reply_to')
    return id
  },

  /**
   * Отметка об отправке (реестр отправки): кому, как и когда. Первая отправка
   * зарегистрированного исходящего переводит его в «Исполнен» — исходящий
   * исполняется отправкой; следующие отметки — дополнительные адресаты.
   */
  async dispatch(
    tx: Executor,
    ctx: Ctx,
    documentId: string,
    input: DocumentDispatchInput,
  ): Promise<string> {
    await authorize(ctx, 'dispatch', documentId)
    const row = await DocumentService.load(tx, documentId, true)
    if (!row) throw errors.notFound('Документ')
    if ((await directionOf(tx, row.typeId)) !== 'outgoing') {
      throw errors.conflict('Отправка отмечается у исходящего документа')
    }
    const status = row.status as DocumentStatus
    if (!DISPATCHABLE_STATUSES.includes(status)) {
      throw errors.conflict('Отметить отправку можно у зарегистрированного исходящего', {
        status,
      })
    }
    let addressee = input.addressee
    if (input.correspondentId) {
      const found = (await CorrespondentService.names(tx, [input.correspondentId])).get(
        input.correspondentId,
      )
      if (!found) {
        throw errors.validation('Корреспондент не найден', [
          { path: 'correspondentId', message: 'correspondent' },
        ])
      }
      addressee = addressee || found.name
    }
    const dispatchId = newId()
    await tx.insert(documentDispatches).values({
      id: dispatchId,
      documentId,
      correspondentId: input.correspondentId,
      addressee: input.addressee,
      method: input.method,
      sentOn: input.sentOn,
      tracking: input.tracking,
      note: input.note,
      createdBy: actorId(ctx),
    })
    const first = status === 'registered'
    if (first) {
      await applyTransition(tx, ctx, documentId, {
        to: 'executed',
        cause: 'dispatch',
        source: { kind: 'dispatch', id: dispatchId },
      })
    }
    const [earliest] = await tx
      .select({ sentOn: sql<string>`min(${documentDispatches.sentOn})::text` })
      .from(documentDispatches)
      .where(eq(documentDispatches.documentId, documentId))
    await ObjectService.update(
      tx,
      ctx,
      documentId,
      { meta: { dispatched: true, sentOn: earliest?.sentOn ?? input.sentOn }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'document.dispatched',
      object: { id: documentId, type: 'document', spaceId: row.spaceId, title: row.title },
      payload: {
        dispatchId,
        method: input.method,
        sentOn: input.sentOn,
        addressee: addressee ?? '',
        first,
      },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.documentDispatched,
        objectId: documentId,
        objectType: 'document',
        details: { dispatchId, method: input.method, sentOn: input.sentOn, first },
      },
      tx,
    )
    return dispatchId
  },

  async dispatches(ctx: UserCtx, documentId: string): Promise<DocumentDispatch[]> {
    await authorize(ctx, 'view', documentId)
    const rows = await db()
      .select()
      .from(documentDispatches)
      .where(eq(documentDispatches.documentId, documentId))
      .orderBy(asc(documentDispatches.sentOn), asc(documentDispatches.createdAt))
    const [correspondents, people] = await Promise.all([
      CorrespondentService.names(db(), [
        ...new Set(rows.map((row) => row.correspondentId).filter((v): v is string => !!v)),
      ]),
      directory().refs([
        ...new Set(rows.map((row) => row.createdBy).filter((v): v is string => !!v)),
      ]),
    ])
    return rows.map((row) => ({
      id: row.id,
      correspondent: row.correspondentId ? (correspondents.get(row.correspondentId) ?? null) : null,
      addressee: row.addressee,
      method: row.method as DeliveryMethod,
      sentOn: row.sentOn,
      tracking: row.tracking,
      note: row.note,
      createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
      createdAt: row.createdAt,
    }))
  },

  /**
   * Цепочка переписки: документы, связанные `reply_to` с этим — в обе стороны
   * и транзитивно (входящее → ответ → новое входящее в ответ на ответ…).
   * Недоступные смотрящему (нет права или гриф выше допуска) — без реквизитов.
   */
  async chain(ctx: UserCtx, documentId: string): Promise<CorrespondenceChain> {
    await authorize(ctx, 'view', documentId)
    const seen = new Set<string>([documentId])
    const replyTo = new Map<string, string>()
    let frontier = [documentId]
    let truncated = false
    while (frontier.length > 0) {
      const edges = await LinkService.edges(frontier, 'reply_to')
      const next: string[] = []
      for (const edge of edges) {
        if (!replyTo.has(edge.sourceId)) replyTo.set(edge.sourceId, edge.targetId)
        for (const id of [edge.sourceId, edge.targetId]) {
          if (seen.has(id)) continue
          if (seen.size >= CHAIN_LIMIT) {
            truncated = true
            continue
          }
          seen.add(id)
          next.push(id)
        }
      }
      frontier = next
    }

    const rows = await db()
      .select({
        id: documents.id,
        status: documents.status,
        subject: objects.title,
        regNumber: documents.regNumber,
        regDate: documents.regDate,
        receivedDate: documents.receivedDate,
        correspondentId: documents.correspondentId,
        direction: documentTypes.direction,
        createdAt: objects.createdAt,
        // Внешняя ссылка — буквально: в списке select Drizzle не квалифицирует столбцы
        sentOn: sql<string | null>`(SELECT min(dd.sent_on)::text FROM ${documentDispatches} dd
          WHERE dd.document_id = "documents"."id")`,
      })
      .from(documents)
      .innerJoin(objects, eq(objects.id, documents.id))
      .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
      .where(and(inArray(documents.id, [...seen]), sql`${objects.deletedAt} IS NULL`))
    const correspondents = await CorrespondentService.names(db(), [
      ...new Set(rows.map((row) => row.correspondentId).filter((v): v is string => !!v)),
    ])
    const present = new Set(rows.map((row) => row.id))
    const items: Array<CorrespondenceItem & { order: string }> = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      const target = replyTo.get(row.id)
      const base = {
        id: row.id,
        replyToId: target && present.has(target) ? target : null,
        current: row.id === documentId,
        order: row.regDate ?? row.receivedDate ?? row.createdAt.slice(0, 10),
      }
      items.push(
        decision.allowed
          ? {
              ...base,
              accessible: true,
              direction: row.direction as DocumentDirection,
              status: row.status as DocumentStatus,
              subject: row.subject,
              regNumber: row.regNumber,
              regDate: row.regDate,
              correspondent: row.correspondentId
                ? (correspondents.get(row.correspondentId) ?? null)
                : null,
              sentOn: row.sentOn,
            }
          : {
              ...base,
              accessible: false,
              direction: null,
              status: null,
              subject: '',
              regNumber: null,
              regDate: null,
              correspondent: null,
              sentOn: null,
            },
      )
    }
    items.sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id))
    return { items: items.map(({ order: _order, ...item }) => item), truncated }
  },
}
