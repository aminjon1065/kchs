import type { EventEnvelope, NotificationCategory } from '@kchs/contracts'
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import type { Subscriber } from '~/kernel/events/types.js'
import { NotificationService } from '~/kernel/notifications/service.js'
import { emitToRoom, emitToUser } from '~/kernel/realtime/gateway.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { UserService } from '~/modules/identity/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { chatConversations, conversationMembers } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { ChatService, loadConversation } from './chat-service.js'
import { indexMessage, removeMessageFromIndex } from './message-search.js'
import { PresenceService } from './presence.js'

/** Адрес беседы в веб-клиенте: экран «Чаты» с выбранной беседой. */
const chatUrl = (conversationId: string, objectId: string | null): string =>
  objectId ? `/o/${objectId}` : `/chats?conversation=${conversationId}`

/** Участники, которым беседа не «без звука», кроме автора. */
async function recipients(conversationId: string, authorId: string | null): Promise<string[]> {
  const rows = await db()
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        // «Без звука» — участник в списке остаётся, уведомление не получает
        or(isNull(conversationMembers.mutedUntil), lte(conversationMembers.mutedUntil, sql`now()`)),
      ),
    )
  return rows.map((row) => row.userId).filter((userId) => userId !== authorId)
}

/**
 * «Не беспокоить», тихие часы и встреча оставляют только значок в приложении:
 * статус присутствия связан с настройками уведомлений (ADR-0090).
 */
async function channelsFor(userId: string): Promise<Array<'app' | 'email' | 'telegram'>> {
  const profile = await UserService.profile(userId)
  const quiet = await PresenceService.quiet(userId, profile?.timezone ?? 'Asia/Dushanbe')
  return quiet ? ['app'] : ['app', 'email', 'telegram']
}

async function notifyEach(
  userIds: string[],
  input: {
    category: NotificationCategory
    titleKey: string
    conversationId: string
    objectId: string | null
    actorId: string | null
    params: Record<string, unknown>
  },
): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    if (userId === input.actorId) continue
    await NotificationService.notify({
      userIds: [userId],
      category: input.category,
      titleKey: input.titleKey,
      params: input.params,
      objectId: input.conversationId,
      actorId: input.actorId,
      url: chatUrl(input.conversationId, input.objectId),
      aggregateKey: `${input.category}:${input.conversationId}`,
      channels: await channelsFor(userId),
    })
  }
}

/** Уведомления о сообщениях чатов: `chat.direct`, `chat.mention`, `chat.channel`. */
async function notifyMessage(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'conversation') return
  const conversationId = String(event.payload.conversationId)
  const conversation = await loadConversation(db(), conversationId)
  if (!conversation) return
  const actorId = event.actor.userId
  const preview = String(event.payload.preview ?? '').slice(0, 140)
  const mentions = (event.payload.mentions as string[] | undefined) ?? []
  const members = await recipients(conversationId, actorId)
  const mentioned = new Set(mentions)

  if (event.type === 'mention.created') {
    await notifyEach([...mentioned], {
      category: 'chat.mention',
      titleKey: 'notifications.tpl.chatMention',
      conversationId,
      objectId: conversation.objectId,
      actorId,
      params: { title: conversation.title, preview },
    })
    return
  }

  const rest = members.filter((userId) => !mentioned.has(userId))
  if (rest.length === 0) return
  const direct = conversation.kind === 'direct'
  await notifyEach(rest, {
    category: direct ? 'chat.direct' : 'chat.channel',
    titleKey: direct ? 'notifications.tpl.chatDirect' : 'notifications.tpl.chatChannel',
    conversationId,
    objectId: conversation.objectId,
    actorId,
    params: { title: conversation.title, preview },
  })
}

/** Индекс сообщений для глобального поиска. */
async function indexMessages(event: EventEnvelope): Promise<void> {
  const messageId = Number(event.payload.messageId)
  if (!Number.isInteger(messageId)) return
  try {
    if (event.type === 'message.deleted') await removeMessageFromIndex(messageId)
    else await indexMessage(messageId)
  } catch (error) {
    logger().warn({ err: error, messageId }, 'сообщение не проиндексировано')
  }
}

/** Прочтение на одном устройстве — непрочитанное читателя на остальных (ADR-0161). */
async function refreshReader(event: EventEnvelope): Promise<void> {
  const userId = String(event.payload.userId ?? '')
  const conversationId = String(event.payload.conversationId ?? '')
  if (userId && conversationId) emitToUser(userId, 'chat.changed', { conversationId })
}

/** Открытые списки бесед перечитываются: у участников изменилось непрочитанное. */
async function refreshLists(event: EventEnvelope): Promise<void> {
  const conversationId = String(event.payload.conversationId ?? event.object?.id ?? '')
  if (!conversationId) return
  emitToRoom(`conversation:${conversationId}`, 'chat.changed', { conversationId })
  for (const userId of await ChatService.memberIds(conversationId)) {
    emitToUser(userId, 'chat.changed', { conversationId })
  }
}

/** Канал подразделения — как календарь подразделения (ADR-0081). */
async function spaceChannel(event: EventEnvelope): Promise<void> {
  if (event.payload.kind !== 'unit' || !event.object) return
  const spaceId = event.object.id
  const conversationId = await db().transaction((tx) =>
    ChatService.ensureSpaceChannel(tx, systemCtx('chat.space'), spaceId),
  )
  await syncChannelMembers(conversationId, spaceId)
}

/** Состав канала подразделения повторяет состав его пространства. */
async function syncChannelMembers(conversationId: string, spaceId: string): Promise<void> {
  const members = await SpaceService.members(spaceId)
  if (members.length === 0) return
  await db()
    .insert(conversationMembers)
    .values(members.map((member) => ({ conversationId, userId: member.userId })))
    .onConflictDoNothing()
}

async function channelOfSpace(spaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(eq(chatConversations.systemKey, `space:${spaceId}`))
    .limit(1)
  return row?.id ?? null
}

/** Участник пространства попадает в его канал и выбывает из него вместе с ролью. */
async function spaceMembership(event: EventEnvelope): Promise<void> {
  if (!event.object) return
  const conversationId = await channelOfSpace(event.object.id)
  if (!conversationId) return
  const userId = String(event.payload.userId ?? '')
  if (!userId) return
  if (event.type === 'space.member_added') {
    await db().insert(conversationMembers).values({ conversationId, userId }).onConflictDoNothing()
    emitToUser(userId, 'chat.changed', { conversationId })
    return
  }
  await db()
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
  emitToUser(userId, 'chat.changed', { conversationId })
}

/** «На встрече» выставляется автоматически (11-communications-meetings.md §1). */
async function meetingPresence(event: EventEnvelope): Promise<void> {
  const userId = String(event.payload.userId ?? '')
  if (!userId) return
  await PresenceService.setInMeeting(userId, event.type === 'meeting.participant_joined')
}

export const chatSubscribers: Subscriber[] = [
  {
    name: 'chat-notifications',
    types: ['message.posted', 'mention.created'],
    handle: notifyMessage,
  },
  {
    name: 'chat-message-index',
    types: ['message.posted', 'message.edited', 'message.deleted'],
    handle: indexMessages,
  },
  {
    name: 'chat-realtime',
    // Правка и удаление меняют последнее сообщение в списке бесед
    types: [
      'message.posted',
      'message.edited',
      'message.deleted',
      'chat.member_joined',
      'chat.member_left',
      'chat.renamed',
    ],
    handle: refreshLists,
  },
  { name: 'chat-reads', types: ['message.read'], handle: refreshReader },
  { name: 'chat-spaces', types: ['space.created'], handle: spaceChannel },
  {
    name: 'chat-space-membership',
    types: ['space.member_added', 'space.member_removed'],
    handle: spaceMembership,
  },
  {
    name: 'chat-presence',
    types: ['meeting.participant_joined', 'meeting.participant_left'],
    handle: meetingPresence,
  },
]

/** Каналы для пространств подразделений, у которых их ещё нет (старт воркера). */
export async function ensureUnitChannels(): Promise<number> {
  const ctx = systemCtx('chat.units')
  let created = 0
  for (const space of await SpaceService.adminList({ kind: 'unit' })) {
    try {
      const existing = await channelOfSpace(space.id)
      const conversationId =
        existing ??
        (await db().transaction((tx) => ChatService.ensureSpaceChannel(tx, ctx, space.id)))
      if (!existing) created += 1
      await syncChannelMembers(conversationId, space.id)
    } catch (error) {
      logger().warn({ err: error, spaceId: space.id }, 'канал подразделения не создан')
    }
  }
  return created
}
