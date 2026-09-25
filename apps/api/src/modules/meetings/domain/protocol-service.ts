import { isDeepStrictEqual } from 'node:util'
import {
  PROTOCOL_DEFAULT_DUE_WORKING_DAYS,
  PROTOCOL_DOC,
  PROTOCOL_MAX_BLOCKS,
  type ProtocolAcknowledgeInput,
  type ProtocolBlock,
  type ProtocolBlocksInput,
  type ProtocolInstruction,
  type ProtocolRecord,
  type ProtocolRegisterInput,
  type ProtocolStatus,
  parseConfidentiality,
  richBodyText,
} from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import type * as Y from 'yjs'
import { grantAccess, revokeAccess } from '~/kernel/access/acl-service.js'
import { authorize } from '~/kernel/access/authorize.js'
import { Acknowledgments } from '~/kernel/acknowledgments/index.js'
import { CollabService } from '~/kernel/collab/server.js'
import { CollabStore } from '~/kernel/collab/store.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { LinkService } from '~/kernel/links/service.js'
import type { SearchContent } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { DocumentsPublic } from '~/modules/documents/public.js'
import { Instructions } from '~/modules/tasks/public.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { meetings, objects, protocols } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { draftAvailability } from './protocol-assist.js'
import {
  protocolOfMeeting as byMeeting,
  loadProtocol as load,
  meetingParticipantIds,
  meetingSecretaryId,
  type ProtocolRow,
  protocolText,
} from './protocol-core.js'
import { insertProtocolBlocks, protocolState, readProtocol, setBlockTask } from './protocol-doc.js'

/** Текста протокола в поисковом индексе — не больше (как у тетради). */
const SEARCH_BODY_LIMIT = 20_000

/** Дело Входящих организатора после встречи: «Проверить протокол». */
export const REVIEW_INBOX_KIND = 'review_protocol'

/** Пометка записи ACL секретаря на протоколе: права выданы назначением, а не вручную. */
const SECRETARY_NOTE = 'meeting:secretary'

/** Право секретаря править протокол — своя запись `edit` поверх наследуемых от встречи. */
async function grantSecretary(
  tx: Executor,
  ctx: Ctx,
  protocolId: string,
  userId: string,
): Promise<void> {
  await grantAccess(
    tx,
    ctx,
    protocolId,
    [{ principal: { type: 'user', id: userId }, level: 'edit', note: SECRETARY_NOTE }],
    { quiet: true },
  )
}

/** Поручения протокола: видимые смотрящему — целиком, прочие — ключом и состоянием. */
async function instructionsOf(ctx: UserCtx, row: ProtocolRow): Promise<ProtocolInstruction[]> {
  const pairs = Object.entries(row.instructions)
  if (pairs.length === 0) return []
  const visible = new Map((await Instructions.bySource(ctx, row.id)).map((item) => [item.id, item]))
  return pairs.map(([blockId, taskId]) => {
    const task = visible.get(taskId)
    const block = row.blocks.find((item) => item.id === blockId)
    return {
      blockId,
      taskId,
      key: task?.key ?? '',
      title: task?.title ?? block?.title ?? '',
      status: task?.status ?? 'unknown',
      assignee: task?.assignee ?? null,
      dueAt: task?.dueAt ?? null,
      accessible: Boolean(task),
    }
  })
}

async function toRecord(ctx: UserCtx, row: ProtocolRow): Promise<ProtocolRecord> {
  const [edit, manage, ack, instructions] = await Promise.all([
    authorize(ctx, 'edit', row.id, { soft: true }),
    authorize(ctx, 'manage', row.id, { soft: true }),
    authorize(ctx, 'request_acknowledgment', row.id, { soft: true }),
    instructionsOf(ctx, row),
  ])
  const confirmed = row.status === 'confirmed'
  const draft = await draftAvailability(ctx, row.id)
  return {
    id: row.id,
    meetingId: row.meetingId,
    title: row.title,
    status: row.status as ProtocolStatus,
    blocks: row.blocks,
    summary: row.summary,
    documentId: row.documentId,
    confirmedAt: row.confirmedAt,
    confirmedBy: row.confirmedBy
      ? ((await directory().refs([row.confirmedBy])).get(row.confirmedBy) ?? null)
      : null,
    instructions,
    acknowledgmentRequested: row.acknowledgmentAt !== null,
    can: {
      edit: edit.allowed && !confirmed,
      confirm: manage.allowed && !confirmed,
      register: manage.allowed && confirmed && row.documentId === null,
      requestAcknowledgment: ack.allowed && confirmed,
      draft: edit.allowed && !confirmed && draft.available,
    },
    version: row.version,
    updatedAt: row.updatedAt,
  }
}

/**
 * Блоки без исполнителя или текста подтвердить нельзя: поручение из них не соберётся.
 * Срок не обязателен — без него ставится `PROTOCOL_DEFAULT_DUE_WORKING_DAYS` (N33).
 */
function incompleteInstructions(blocks: readonly ProtocolBlock[]): string[] {
  return blocks
    .filter(
      (block) =>
        block.kind === 'instruction' &&
        !block.taskId &&
        (!block.assigneeId || !(block.title.trim() || richBodyText(block.body))),
    )
    .map((block) => block.id)
}

/** Название поручения: заголовок блока, иначе первая строка его текста. */
function instructionTitle(block: ProtocolBlock): string {
  const text = block.title.trim() || richBodyText(block.body).split('\n')[0] || ''
  return text.slice(0, 300)
}

/**
 * Протокол встречи (11-communications-meetings.md §4, ADR-0093): объект
 * реестра — ребёнок встречи, тело — совместный документ Yjs. Повестку ведут до
 * встречи, после встречи тот же документ становится протоколом; подтверждение
 * превращает блоки `instruction` в поручения, регистрация — в документ.
 */
export const ProtocolService = {
  load,
  byMeeting,

  /**
   * Протокол встречи: создаётся один раз — повесткой до встречи или делом
   * «Проверить протокол» после неё. Права наследуются от встречи: участник
   * видит и правит протокол, организатор — подтверждает.
   */
  async ensure(tx: Executor, ctx: Ctx, meetingId: string): Promise<string> {
    const existing = await byMeeting(tx, meetingId)
    if (existing) return existing.id
    const [meeting] = await tx
      .select({
        id: meetings.id,
        organizerId: meetings.organizerId,
        title: objects.title,
        spaceId: objects.spaceId,
        confidentiality: objects.confidentiality,
      })
      .from(meetings)
      .innerJoin(objects, eq(objects.id, meetings.id))
      .where(eq(meetings.id, meetingId))
      .limit(1)
    if (!meeting) throw errors.notFound('Встреча')
    const id = newId()
    await ObjectService.create(tx, ctx, {
      id,
      type: 'protocol',
      spaceId: meeting.spaceId,
      parentId: meetingId,
      title: `Протокол: ${meeting.title}`,
      ...(meeting.organizerId ? { ownerId: meeting.organizerId } : {}),
      confidentiality: parseConfidentiality(meeting.confidentiality, 'public'),
    })
    await tx.insert(protocols).values({ id, meetingId, status: 'agenda' })
    // Состояние Yjs — сразу: первое открытие не строит документ из JSON
    await CollabStore.create(tx, id, protocolState({ blocks: [], summary: null }))
    // Секретаря могли назначить раньше, чем завели протокол
    const secretary = await meetingSecretaryId(tx, meetingId)
    if (secretary && secretary !== meeting.organizerId) {
      await grantSecretary(tx, ctx, id, secretary)
    }
    return id
  },

  /**
   * Секретарь сменился (N30): прежний теряет право правки протокола, новый
   * получает; протокол заводится сразу — секретарю есть что вести.
   */
  async syncSecretary(
    tx: Executor,
    ctx: Ctx,
    meetingId: string,
    previousId: string | null,
    nextId: string | null,
  ): Promise<void> {
    const existing = await byMeeting(tx, meetingId)
    if (!existing && !nextId) return
    const id = existing?.id ?? (await ProtocolService.ensure(tx, ctx, meetingId))
    if (previousId && previousId !== nextId) {
      await revokeAccess(tx, ctx, id, { type: 'user', id: previousId })
    }
    // Новому секретарю право выдаёт уже `ensure`, если протокол заведён только что
    if (nextId && existing) await grantSecretary(tx, ctx, id, nextId)
  },

  async get(ctx: UserCtx, id: string): Promise<ProtocolRecord> {
    await authorize(ctx, 'view', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Протокол')
    return toRecord(ctx, row)
  },

  /** Протокол встречи для её карточки; null — ещё не заведён. */
  async ofMeeting(ctx: UserCtx, meetingId: string): Promise<ProtocolRecord | null> {
    await authorize(ctx, 'view', meetingId)
    const row = await byMeeting(db(), meetingId)
    return row ? toRecord(ctx, row) : null
  },

  /** Повестку (и протокол) заводит тот, кто распоряжается встречей. */
  async create(ctx: UserCtx, meetingId: string): Promise<ProtocolRecord> {
    await authorize(ctx, 'edit', meetingId)
    const id = await db().transaction((tx) => ProtocolService.ensure(tx, ctx, meetingId))
    return ProtocolService.get(ctx, id)
  },

  /**
   * Блоки от сервера (повестка из карточки встречи, черновик ИИ) — через
   * совместный документ: у открывших протокол они появляются сразу, снимок
   * записан к возврату (как ячейки тетради, ADR-0070 §7).
   */
  async addBlocks(ctx: UserCtx, id: string, input: ProtocolBlocksInput): Promise<ProtocolRecord> {
    await authorize(ctx, 'edit', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Протокол')
    if (row.status === 'confirmed') throw errors.conflict('Протокол уже подтверждён')
    await CollabService.change(ctx, { id, type: 'protocol' }, (doc) => {
      const count = doc.getArray(PROTOCOL_DOC.order).length
      if (count + input.blocks.length > PROTOCOL_MAX_BLOCKS) {
        throw errors.conflict(`В протоколе не больше ${PROTOCOL_MAX_BLOCKS} блоков`)
      }
      insertProtocolBlocks(doc, input.blocks, input.index)
    })
    return ProtocolService.get(ctx, id)
  },

  /**
   * Подтверждение протокола организатором: блоки `instruction` становятся
   * поручениями (`Instructions.create`, источник — протокол), их ключи
   * возвращаются в документ. Снимок перед этим берётся из открытого документа:
   * подтверждается то, что видит организатор.
   */
  async confirm(ctx: UserCtx, id: string): Promise<ProtocolRecord> {
    await authorize(ctx, 'manage', id)
    const before = await load(db(), id)
    if (!before) throw errors.notFound('Протокол')
    if (before.status === 'confirmed') throw errors.conflict('Протокол уже подтверждён')
    // Снимок открытого документа: дальше работаем с записанным в базу JSON
    await CollabService.change(ctx, { id, type: 'protocol' }, () => {})

    const created = await db().transaction(async (tx) => {
      const row = await load(tx, id)
      if (!row) throw errors.notFound('Протокол')
      if (row.status === 'confirmed') throw errors.conflict('Протокол уже подтверждён')
      const incomplete = incompleteInstructions(row.blocks)
      if (incomplete.length > 0) {
        throw new AppError('conflict', 'У поручения протокола нет исполнителя или текста', 409, {
          data: { reason: 'incomplete_instruction', blockIds: incomplete },
        })
      }
      const links: Record<string, string> = { ...row.instructions }
      const blocks: ProtocolBlock[] = []
      for (const block of row.blocks) {
        if (block.kind !== 'instruction' || block.taskId) {
          blocks.push(block)
          continue
        }
        const instruction = await Instructions.create(tx, ctx, {
          title: instructionTitle(block),
          description: richBodyText(block.body) || null,
          source: { kind: 'object', objectId: id },
          assigneeId: block.assigneeId as string,
          ...(block.controllerId ? { controllerId: block.controllerId } : {}),
          // Срок не назван — 10 рабочих дней по производственному календарю (N33)
          due: block.dueAt
            ? { at: `${block.dueAt}T23:59:59.000Z` }
            : { workingDays: PROTOCOL_DEFAULT_DUE_WORKING_DAYS },
        })
        links[block.id] = instruction.id
        blocks.push({ ...block, taskId: instruction.id })
      }
      await tx
        .update(protocols)
        .set({
          status: 'confirmed',
          blocks,
          instructions: links,
          confirmedAt: sql`now()`,
          confirmedBy: ctx.onBehalfOf ?? ctx.userId,
          updatedAt: sql`now()`,
        })
        .where(eq(protocols.id, id))
      const decisions = blocks.filter((block) => block.kind === 'decision').length
      await publishEvent(tx, ctx, {
        type: 'protocol.confirmed',
        object: { id, type: 'protocol', spaceId: row.spaceId, title: row.title },
        payload: {
          meetingId: row.meetingId,
          decisions,
          taskIds: Object.values(links),
        },
      })
      await InboxService.resolve(tx, ctx, { objectId: id, kind: REVIEW_INBOX_KIND })
      return blocks
    })

    // Ключи поручений — обратно в документ: состояние видно всем, кто его открыл
    const assigned = created.filter(
      (block): block is Extract<ProtocolBlock, { kind: 'instruction' }> =>
        block.kind === 'instruction' && Boolean(block.taskId),
    )
    if (assigned.length > 0) {
      await CollabService.change(ctx, { id, type: 'protocol' }, (doc) => {
        for (const block of assigned) setBlockTask(doc, block.id, block.taskId as string)
      })
    }
    return ProtocolService.get(ctx, id)
  },

  /**
   * Регистрация протокола документом (16-api-and-events.md §4
   * `documents.public.registerProtocol`): документ выбранного типа с текстом
   * протокола; маршрут согласования и подписи запускается уже существующим
   * механизмом из карточки документа (ADR-0083).
   */
  async register(
    ctx: UserCtx,
    id: string,
    input: ProtocolRegisterInput,
  ): Promise<{ documentId: string }> {
    await authorize(ctx, 'manage', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Протокол')
    if (row.status !== 'confirmed') {
      throw errors.conflict('Протокол ещё не подтверждён', { status: row.status })
    }
    if (row.documentId) {
      throw new AppError('conflict', 'Протокол уже зарегистрирован документом', 409, {
        data: { reason: 'already_registered', documentId: row.documentId },
      })
    }
    const documentId = await db().transaction(async (tx) => {
      const created = await DocumentsPublic.create(tx, ctx, {
        typeId: input.typeId,
        subject: row.title.slice(0, 1000),
        summary: protocolText(row.blocks, row.summary).slice(0, 20_000) || null,
      })
      await tx
        .update(protocols)
        .set({ documentId: created, registeredAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(protocols.id, id))
      await LinkService.link(tx, ctx, id, created, 'related', { reason: 'protocol' })
      await publishEvent(tx, ctx, {
        type: 'protocol.registered',
        object: { id, type: 'protocol', spaceId: row.spaceId, title: row.title },
        payload: { meetingId: row.meetingId, documentId: created, typeId: input.typeId },
      })
      return created
    })
    return { documentId }
  },

  /**
   * Ознакомление участников с протоколом — механизмом ядра (ADR-0084): права
   * получателей уже есть (участник встречи видит её протокол).
   */
  async requestAcknowledgment(
    ctx: UserCtx,
    id: string,
    input: ProtocolAcknowledgeInput,
  ): Promise<{ requested: number }> {
    await authorize(ctx, 'request_acknowledgment', id)
    const row = await load(db(), id)
    if (!row) throw errors.notFound('Протокол')
    if (row.status !== 'confirmed') {
      throw errors.conflict('Протокол ещё не подтверждён', { status: row.status })
    }
    return db().transaction(async (tx) => {
      // По умолчанию — участники встречи, кроме того, кто отправляет: он
      // протокол подтвердил, просить его ознакомиться с ним незачем
      const me = ctx.onBehalfOf ?? ctx.userId
      const userIds =
        input.userIds.length > 0
          ? input.userIds
          : (await meetingParticipantIds(tx, row.meetingId)).filter((userId) => userId !== me)
      const outcome = await Acknowledgments.request(tx, ctx, {
        objectId: id,
        source: 'manual',
        userIds,
        dueAt: input.dueAt ? `${input.dueAt}T23:59:59.000Z` : null,
      })
      await tx
        .update(protocols)
        .set({ acknowledgmentAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(protocols.id, id))
      return { requested: outcome.added.length }
    })
  },

  /** Начальное состояние для протокола без документа Yjs (создан раньше). */
  async initialState(id: string, executor: Executor): Promise<Uint8Array | null> {
    const row = await load(executor, id)
    if (!row) return null
    return protocolState({ blocks: row.blocks, summary: row.summary })
  },

  /**
   * Снимок после совместной правки (ядро вызывает в транзакции записи
   * состояния): JSON блоков и резюме, версия объекта и `protocol.updated`.
   * Подтверждённый протокол правкам не подлежит — снимок его не меняет.
   */
  async snapshot(tx: Executor, ctx: Ctx, id: string, doc: Y.Doc): Promise<void> {
    const next = readProtocol(doc)
    const row = await load(tx, id)
    if (!row || row.status === 'confirmed') return
    const changed: Array<'blocks' | 'summary'> = []
    if (!isDeepStrictEqual(row.blocks, next.blocks)) changed.push('blocks')
    if (row.summary !== next.summary) changed.push('summary')
    if (changed.length === 0) return

    const status: ProtocolStatus =
      row.status === 'agenda' && next.blocks.some((block) => block.kind !== 'agenda_item')
        ? 'draft'
        : (row.status as ProtocolStatus)
    await tx
      .update(protocols)
      .set({ blocks: next.blocks, summary: next.summary, status, updatedAt: sql`now()` })
      .where(eq(protocols.id, id))
    const object = await ObjectService.update(tx, ctx, id, {}, { silent: true })
    await publishEvent(tx, ctx, {
      type: 'protocol.updated',
      object: { id, type: 'protocol', spaceId: object.spaceId, title: object.title },
      payload: { meetingId: row.meetingId, changed },
    })
  },

  /** Документ поиска: название и текст блоков протокола. */
  async searchable(id: string): Promise<SearchContent | null> {
    const row = await load(db(), id)
    if (!row) return null
    return {
      parentId: row.meetingId,
      type: 'protocol',
      spaceId: row.spaceId,
      title: row.title,
      body: protocolText(row.blocks, row.summary).slice(0, SEARCH_BODY_LIMIT),
      updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
      meta: { status: row.status },
    }
  },
}
