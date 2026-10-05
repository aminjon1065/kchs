import type { ChatCreateInput, ChatMember, ChatMemberRole, ChatPrivacy } from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { grantAccess, revokeAccess } from '~/kernel/access/acl-service.js'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { DiscussionMembers } from '~/kernel/discussions/members.js'
import { DiscussionQueries } from '~/kernel/discussions/queries.js'
import { DiscussionService } from '~/kernel/discussions/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { chatConversations } from '../schema.js'
import { chatsSpaceId } from './space.js'

export interface ConversationRow {
  id: string
  kind: string
  privacy: string
  objectId: string | null
  spaceId: string | null
  title: string
  ownerId: string | null
  systemKey: string | null
}

/** Беседа ядра и её сведения мессенджера (системный ключ канала подразделения). */
export async function loadConversation(
  executor: Executor,
  id: string,
): Promise<ConversationRow | null> {
  const conversation = await DiscussionQueries.conversation(executor, id)
  if (!conversation) return null
  const [chat] = await executor
    .select({ systemKey: chatConversations.systemKey })
    .from(chatConversations)
    .where(eq(chatConversations.id, id))
    .limit(1)
  return { ...conversation, systemKey: chat?.systemKey ?? null }
}

/** Ключ личной беседы: пара идентификаторов по возрастанию — одна беседа на двоих. */
export function directKeyOf(a: string, b: string): string {
  return [a, b].sort().join(':')
}

function userOf(ctx: UserCtx): string {
  return ctx.onBehalfOf ?? ctx.userId
}

/** Участники беседы получают её тихими записями ACL (как участники встречи, ADR-0089). */
async function grantMembers(
  tx: Executor,
  ctx: Ctx,
  conversationId: string,
  userIds: readonly string[],
  ownerId: string | null,
): Promise<void> {
  const grants = userIds
    .filter((id) => id !== ownerId)
    .map((id) => ({ principal: { type: 'user' as const, id }, level: 'comment' as const }))
  if (grants.length > 0) await grantAccess(tx, ctx, conversationId, grants, { quiet: true })
}

async function addMemberRows(
  tx: Executor,
  conversationId: string,
  userIds: readonly string[],
  role: ChatMemberRole = 'member',
): Promise<void> {
  await DiscussionMembers.add(tx, conversationId, userIds, role)
}

async function memberIdsOf(executor: Executor, conversationId: string): Promise<string[]> {
  return DiscussionMembers.ids(conversationId, executor)
}

/**
 * Беседы мессенджера (11-communications-meetings.md §1, ADR-0090). Сама беседа —
 * объект реестра `conversation` ядра; модуль заводит её виды и состав участников.
 */
export const ChatService = {
  loadConversation,

  /**
   * Личная беседа пары: детерминированный ключ и блокировка на нём не дают
   * появиться второй беседе, если оба написали друг другу одновременно.
   */
  async ensureDirect(tx: Executor, ctx: UserCtx, peerId: string): Promise<string> {
    const me = userOf(ctx)
    if (peerId === me) throw errors.validation('Нельзя начать беседу с самим собой')
    const [peer] = await directory().activeUsers([peerId])
    if (!peer) throw errors.notFound('Пользователь')

    const key = directKeyOf(me, peerId)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`chat:direct:${key}`}))`)
    const [existing] = await tx
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.directKey, key))
      .limit(1)
    if (existing) return existing.id

    const spaceId = await chatsSpaceId(tx)
    const names = await directory().refs([me, peerId])
    const id = await DiscussionService.createConversation(tx, ctx, {
      id: newId(),
      kind: 'direct',
      privacy: 'closed',
      spaceId,
      title: [names.get(me)?.displayName ?? '', names.get(peerId)?.displayName ?? '']
        .filter(Boolean)
        .join(' — '),
      // Личная беседа не принадлежит одному из собеседников: оба — участники
      ownerId: null,
      accessMode: 'restricted',
    })
    await tx.insert(chatConversations).values({ id, directKey: key, createdBy: me })
    await addMemberRows(tx, id, [me, peerId])
    await grantMembers(tx, ctx, id, [me, peerId], null)
    await publishEvent(tx, ctx, {
      type: 'chat.created',
      object: { id, type: 'conversation', spaceId, title: 'direct' },
      payload: { kind: 'direct', privacy: 'closed', memberIds: [me, peerId] },
    })
    return id
  },

  /** Группа и канал: канал живёт в пространстве, группа — в системном пространстве чатов. */
  async create(tx: Executor, ctx: UserCtx, input: ChatCreateInput): Promise<string> {
    if (input.kind === 'direct') {
      const [peerId] = input.memberIds
      if (!peerId) throw errors.validation('Нужен собеседник')
      return ChatService.ensureDirect(tx, ctx, peerId)
    }

    const title = input.title?.trim()
    if (!title) throw errors.validation('Нужно название беседы')

    const me = userOf(ctx)
    const privacy: ChatPrivacy = input.kind === 'group' ? 'closed' : input.privacy
    let spaceId: string
    if (input.kind === 'channel') {
      if (!input.spaceId) throw errors.validation('Канал создаётся в пространстве')
      // Право на пространство проверяет ядро: канал заводит его участник
      await authorize(ctx, 'view', input.spaceId)
      spaceId = input.spaceId
    } else {
      spaceId = await chatsSpaceId(tx)
    }

    const members = [...new Set([me, ...(await directory().activeUsers([...input.memberIds]))])]
    const id = await DiscussionService.createConversation(tx, ctx, {
      id: newId(),
      kind: input.kind,
      privacy,
      spaceId,
      title,
      ownerId: me,
      // Открытый канал наследует права пространства: его видит любой участник
      accessMode: privacy === 'open' ? 'inherit' : 'restricted',
    })
    await tx.insert(chatConversations).values({ id, createdBy: me })
    await addMemberRows(tx, id, [me], 'owner')
    await addMemberRows(
      tx,
      id,
      members.filter((userId) => userId !== me),
    )
    if (privacy !== 'open') await grantMembers(tx, ctx, id, members, me)
    await publishEvent(tx, ctx, {
      type: 'chat.created',
      object: { id, type: 'conversation', spaceId, title },
      payload: { kind: input.kind, privacy, memberIds: members },
    })
    return id
  },

  /**
   * Канал подразделения — как календарь подразделения (ADR-0081): открытый
   * канал в пространстве `unit`, без владельца; правят администраторы
   * пространства. Идемпотентно по системному ключу.
   */
  async ensureSpaceChannel(tx: Executor, ctx: Ctx, spaceId: string): Promise<string> {
    const systemKey = `space:${spaceId}`
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`chat:${systemKey}`}))`)
    const [existing] = await tx
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.systemKey, systemKey))
      .limit(1)
    if (existing) return existing.id

    const [space] = await tx
      .select({ title: objects.title })
      .from(objects)
      .where(eq(objects.id, spaceId))
      .limit(1)
    if (!space) throw errors.notFound('Пространство')

    const id = await DiscussionService.createConversation(tx, ctx, {
      id: newId(),
      kind: 'channel',
      privacy: 'open',
      spaceId,
      title: space.title,
      ownerId: null,
      accessMode: 'inherit',
      meta: { system: systemKey },
    })
    await tx.insert(chatConversations).values({ id, systemKey })
    await publishEvent(tx, ctx, {
      type: 'chat.created',
      object: { id, type: 'conversation', spaceId, title: space.title },
      payload: { kind: 'channel', privacy: 'open', memberIds: [] },
    })
    return id
  },

  /** Вступление в открытый канал: право видеть его даёт пространство. */
  async join(tx: Executor, ctx: UserCtx, conversationId: string): Promise<void> {
    const row = await loadConversation(tx, conversationId)
    if (!row) throw errors.notFound('Беседа')
    if (row.kind !== 'channel' || row.privacy !== 'open') {
      throw errors.forbidden('В эту беседу вступают по приглашению')
    }
    await authorize(ctx, 'view', conversationId)
    const me = userOf(ctx)
    const before = await memberIdsOf(tx, conversationId)
    if (before.includes(me)) return
    await addMemberRows(tx, conversationId, [me])
    await publishEvent(tx, ctx, {
      type: 'chat.member_joined',
      object: { id: conversationId, type: 'conversation', spaceId: row.spaceId, title: row.title },
      payload: { userIds: [me], invitedBy: null },
    })
  },

  /** Выход: из личной беседы и обсуждения объекта не выходят. */
  async leave(tx: Executor, ctx: UserCtx, conversationId: string): Promise<void> {
    const row = await loadConversation(tx, conversationId)
    if (!row) throw errors.notFound('Беседа')
    if (row.kind === 'direct' || row.kind === 'object') {
      throw errors.validation('Из этой беседы нельзя выйти')
    }
    const me = userOf(ctx)
    if (row.ownerId === me) {
      throw errors.validation('Владелец не может выйти: передайте беседу или удалите её')
    }
    if (!(await DiscussionMembers.remove(tx, conversationId, me))) return
    if (row.privacy !== 'open') {
      await revokeAccess(tx, ctx, conversationId, { type: 'user', id: me })
    }
    await publishEvent(tx, ctx, {
      type: 'chat.member_left',
      object: { id: conversationId, type: 'conversation', spaceId: row.spaceId, title: row.title },
      payload: { userIds: [me], removed: false },
    })
  },

  /** Приглашение и исключение — право `manage` на беседе (владелец, администратор пространства). */
  async invite(
    tx: Executor,
    ctx: UserCtx,
    conversationId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    const row = await loadConversation(tx, conversationId)
    if (!row) throw errors.notFound('Беседа')
    if (row.kind === 'direct' || row.kind === 'object') {
      throw errors.validation('В эту беседу нельзя приглашать')
    }
    await authorize(ctx, 'manage', conversationId)
    const before = await memberIdsOf(tx, conversationId)
    const added = (await directory().activeUsers([...userIds])).filter(
      (userId) => !before.includes(userId),
    )
    if (added.length === 0) return []
    await addMemberRows(tx, conversationId, added)
    if (row.privacy !== 'open') await grantMembers(tx, ctx, conversationId, added, row.ownerId)
    await publishEvent(tx, ctx, {
      type: 'chat.member_joined',
      object: { id: conversationId, type: 'conversation', spaceId: row.spaceId, title: row.title },
      payload: { userIds: added, invitedBy: userOf(ctx) },
    })
    return added
  },

  async removeMember(
    tx: Executor,
    ctx: UserCtx,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const row = await loadConversation(tx, conversationId)
    if (!row) throw errors.notFound('Беседа')
    await authorize(ctx, 'manage', conversationId)
    if (row.ownerId === userId) throw errors.validation('Нельзя исключить владельца беседы')
    if (!(await DiscussionMembers.remove(tx, conversationId, userId))) return
    if (row.privacy !== 'open') {
      await revokeAccess(tx, ctx, conversationId, { type: 'user', id: userId })
    }
    await publishEvent(tx, ctx, {
      type: 'chat.member_left',
      object: { id: conversationId, type: 'conversation', spaceId: row.spaceId, title: row.title },
      payload: { userIds: [userId], removed: true },
    })
  },

  async rename(tx: Executor, ctx: UserCtx, conversationId: string, title: string): Promise<void> {
    const row = await loadConversation(tx, conversationId)
    if (!row) throw errors.notFound('Беседа')
    if (row.kind === 'direct' || row.kind === 'object') {
      throw errors.validation('Эту беседу нельзя переименовать')
    }
    await authorize(ctx, 'manage', conversationId)
    if (row.title === title) return
    await ObjectService.update(tx, ctx, conversationId, { title }, { silent: true })
    await publishEvent(tx, ctx, {
      type: 'chat.renamed',
      object: { id: conversationId, type: 'conversation', spaceId: row.spaceId, title },
      payload: { title, from: row.title },
    })
  },

  /** Закрепление, «без звука» и архив — настройка участника, не домен: без события. */
  async setSettings(
    ctx: UserCtx,
    conversationId: string,
    input: { pinned?: boolean; muted?: boolean; archived?: boolean },
  ): Promise<void> {
    await authorize(ctx, 'view', conversationId)
    // Архив у каждого свой (ADR-0161); убранная в архив беседа не закреплена
    await DiscussionMembers.setSettings(conversationId, userOf(ctx), input)
  },

  async members(ctx: UserCtx, conversationId: string): Promise<ChatMember[]> {
    await authorize(ctx, 'view', conversationId)
    const rows = await DiscussionMembers.list(conversationId)
    const refs = await directory().refs(rows.map((row) => row.userId))
    return rows
      .map((row) => {
        const user = refs.get(row.userId)
        if (!user) return null
        return {
          user,
          role: (row.role === 'owner' ? 'owner' : 'member') as ChatMemberRole,
          joinedAt: row.joinedAt,
          lastReadMessageId: row.lastReadMessageId === null ? null : String(row.lastReadMessageId),
        }
      })
      .filter((item): item is ChatMember => item !== null)
  },

  /** Участники беседы — для уведомлений подписчика (внутреннее использование). */
  async memberIds(conversationId: string, executor: Executor = db()): Promise<string[]> {
    return memberIdsOf(executor, conversationId)
  },

  /** Беседы, где пользователь состоит или писал: фильтр поиска сообщений. */
  async myConversationIds(userId: string, limit = 500): Promise<string[]> {
    return DiscussionQueries.involving(userId, limit)
  },
}
