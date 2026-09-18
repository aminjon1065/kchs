import type {
  Conversation,
  ConversationKind,
  Message,
  MessageKind,
  MessagePostInput,
  RichBody,
} from '@kchs/contracts'
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId, isGuest } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  conversationMembers,
  conversations,
  messages,
  objects,
  reactions,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'
import { LinkService } from '../links/service.js'
import { ObjectService } from '../objects/service.js'

/**
 * Обсуждения объектов и чаты — одна сущность (02-platform-kernel.md §6).
 * Беседа объекта создаётся лениво при первом сообщении.
 */
export const DiscussionService = {
  async ensureObjectConversation(tx: Executor, ctx: Ctx, objectId: string): Promise<string> {
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.objectId, objectId))
      .limit(1)
    if (existing) return existing.id

    const [target] = await tx
      .select({
        title: objects.title,
        spaceId: objects.spaceId,
        type: objects.type,
        ownerId: objects.ownerId,
      })
      .from(objects)
      .where(eq(objects.id, objectId))
      .limit(1)
    if (!target) throw errors.notFound()

    // Беседа объекта — его часть: доступ наследуется от объекта, а владелец
    // тот же, что у объекта. Первый комментатор не получает прав на обсуждение,
    // которые пережили бы отзыв его доступа к самому объекту.
    const object = await ObjectService.create(tx, ctx, {
      type: 'conversation',
      spaceId: target.spaceId,
      parentId: objectId,
      title: `Обсуждение: ${target.title}`,
      ownerId: target.ownerId,
      meta: { kind: 'object', objectId },
      silent: true,
    })

    await tx.insert(conversations).values({
      id: object.id,
      kind: 'object',
      objectId,
      privacy: 'closed',
    })

    return object.id
  },

  async post(
    tx: Executor,
    ctx: UserCtx,
    conversationId: string,
    input: MessagePostInput,
    kind: MessageKind = 'user',
  ): Promise<number> {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    if (!conversation) throw errors.notFound('Беседа')

    const [row] = await tx
      .insert(messages)
      .values({
        conversationId,
        authorId: ctx.userId,
        onBehalfOf: ctx.onBehalfOf,
        kind,
        body: input.body as unknown as Record<string, unknown>,
        text: input.text,
        replyToId: input.replyToId ? Number(input.replyToId) : null,
        threadRootId: input.threadRootId ? Number(input.threadRootId) : null,
        attachments: input.attachments as unknown as Array<Record<string, unknown>>,
        mentions: input.mentions,
        mentionedObjectIds: input.mentionedObjectIds,
      })
      .returning({ id: messages.id })

    const messageId = row!.id

    await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`now()`,
        messageCount: sql`${conversations.messageCount} + 1`,
      })
      .where(eq(conversations.id, conversationId))

    if (input.threadRootId) {
      await tx
        .update(messages)
        .set({
          threadReplyCount: sql`${messages.threadReplyCount} + 1`,
          threadLastReplyAt: sql`now()`,
        })
        .where(eq(messages.id, Number(input.threadRootId)))
    }

    // Вложения и упоминания объектов превращаются в связи ядра
    const subjectId = conversation.objectId ?? conversationId
    for (const attachment of input.attachments) {
      await LinkService.link(tx, ctx, subjectId, attachment.fileId, 'attachment')
    }
    for (const mentionedId of input.mentionedObjectIds) {
      await LinkService.link(tx, ctx, subjectId, mentionedId, 'mention')
    }

    const [subject] = await tx
      .select({
        id: objects.id,
        type: objects.type,
        spaceId: objects.spaceId,
        title: objects.title,
      })
      .from(objects)
      .where(eq(objects.id, subjectId))
      .limit(1)

    await publishEvent(tx, ctx, {
      type: 'message.posted',
      object: subject ?? null,
      payload: {
        conversationId,
        messageId: String(messageId),
        preview: input.text.slice(0, 200),
        threadRootId: input.threadRootId ?? null,
        mentions: input.mentions,
      },
    })

    if (input.mentions.length > 0) {
      await publishEvent(tx, ctx, {
        type: 'mention.created',
        object: subject ?? null,
        payload: {
          conversationId,
          messageId: String(messageId),
          userIds: input.mentions,
        },
      })
    }

    return messageId
  },

  /** Системное сообщение: «документ отправлен на согласование». */
  async postSystem(
    tx: Executor,
    ctx: Ctx,
    objectId: string,
    systemKey: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const conversationId = await DiscussionService.ensureObjectConversation(tx, ctx, objectId)
    await tx.insert(messages).values({
      conversationId,
      authorId: actorId(ctx),
      kind: 'system',
      text: systemKey,
      systemKey,
      systemParams: params,
    })
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`now()`, messageCount: sql`${conversations.messageCount} + 1` })
      .where(eq(conversations.id, conversationId))
  },

  async list(
    ctx: UserCtx,
    conversationId: string,
    options: { before?: string; after?: string; threadRootId?: string; limit?: number } = {},
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    const limit = Math.min(options.limit ?? 50, 100)
    const conditions = [eq(messages.conversationId, conversationId)]

    if (options.threadRootId) {
      conditions.push(eq(messages.threadRootId, Number(options.threadRootId)))
    } else {
      conditions.push(isNull(messages.threadRootId))
    }
    if (options.before) conditions.push(lt(messages.id, Number(options.before)))
    if (options.after) conditions.push(gt(messages.id, Number(options.after)))

    const rows = await db()
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(options.after ? asc(messages.id) : desc(messages.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const ordered = options.after ? page : page.reverse()

    const authorIds = [
      ...new Set(ordered.map((r) => r.authorId).filter((v): v is string => Boolean(v))),
    ]
    const authors = await directory().refs(authorIds)

    const messageIds = ordered.map((r) => r.id)
    const reactionRows = messageIds.length
      ? await db().select().from(reactions).where(inArray(reactions.messageId, messageIds))
      : []

    return {
      items: ordered.map((row) => {
        const rows = reactionRows.filter((r) => r.messageId === row.id)
        const grouped = new Map<string, { users: string[]; mine: boolean }>()
        for (const r of rows) {
          const entry = grouped.get(r.emoji) ?? { users: [], mine: false }
          entry.users.push(r.userId)
          if (r.userId === ctx.userId) entry.mine = true
          grouped.set(r.emoji, entry)
        }
        return {
          id: String(row.id),
          conversationId: row.conversationId,
          author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
          kind: row.kind as MessageKind,
          body: (row.body as RichBody | null) ?? null,
          text: row.text,
          systemKey: row.systemKey,
          systemParams: row.systemParams,
          replyToId: row.replyToId ? String(row.replyToId) : null,
          threadRootId: row.threadRootId ? String(row.threadRootId) : null,
          threadReplyCount: row.threadReplyCount,
          threadLastReplyAt: row.threadLastReplyAt,
          attachments: row.attachments as Message['attachments'],
          mentions: row.mentions,
          mentionedObjectIds: row.mentionedObjectIds,
          reactions: [...grouped.entries()].map(([emoji, value]) => ({
            emoji,
            count: value.users.length,
            users: value.users,
            mine: value.mine,
          })),
          editedAt: row.editedAt,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
        }
      }),
      nextCursor: hasMore && ordered[0] ? String(ordered[0].id) : null,
    }
  },

  async edit(
    tx: Executor,
    ctx: UserCtx,
    messageId: number,
    body: RichBody,
    text: string,
  ): Promise<void> {
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!row) throw errors.notFound('Сообщение')
    if (row.authorId !== ctx.userId) throw errors.forbidden('Редактировать может только автор')

    await tx
      .update(messages)
      .set({ body: body as unknown as Record<string, unknown>, text, editedAt: sql`now()` })
      .where(eq(messages.id, messageId))

    await publishEvent(tx, ctx, {
      type: 'message.edited',
      payload: { conversationId: row.conversationId, messageId: String(messageId) },
    })
  },

  async remove(tx: Executor, ctx: UserCtx, messageId: number): Promise<void> {
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1)
    if (!row) throw errors.notFound('Сообщение')
    if (row.authorId !== ctx.userId && !ctx.isSystemAdmin) {
      throw errors.forbidden('Удалить может только автор')
    }
    await tx
      .update(messages)
      .set({ deletedAt: sql`now()`, text: '', body: null })
      .where(eq(messages.id, messageId))
    await publishEvent(tx, ctx, {
      type: 'message.deleted',
      payload: { conversationId: row.conversationId, messageId: String(messageId) },
    })
  },

  async react(ctx: UserCtx, messageId: number, emoji: string, on: boolean): Promise<void> {
    if (on) {
      await db()
        .insert(reactions)
        .values({ messageId, userId: ctx.userId, emoji })
        .onConflictDoNothing()
    } else {
      await db()
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, messageId),
            eq(reactions.userId, ctx.userId),
            eq(reactions.emoji, emoji),
          ),
        )
    }
  },

  async markRead(ctx: UserCtx, conversationId: string, messageId: number): Promise<void> {
    if (isGuest(ctx)) return
    await db()
      .insert(conversationMembers)
      .values({ conversationId, userId: ctx.userId, lastReadMessageId: messageId })
      .onConflictDoUpdate({
        target: [conversationMembers.conversationId, conversationMembers.userId],
        set: { lastReadMessageId: messageId },
      })
  },

  async conversationFor(objectId: string, database: Database = db()): Promise<Conversation | null> {
    const [row] = await database
      .select({
        id: conversations.id,
        kind: conversations.kind,
        objectId: conversations.objectId,
        privacy: conversations.privacy,
        lastMessageAt: conversations.lastMessageAt,
        messageCount: conversations.messageCount,
        title: objects.title,
        spaceId: objects.spaceId,
      })
      .from(conversations)
      .leftJoin(objects, eq(objects.id, conversations.id))
      .where(eq(conversations.objectId, objectId))
      .limit(1)

    if (!row) return null
    return {
      id: row.id,
      kind: row.kind as ConversationKind,
      title: row.title ?? '',
      objectId: row.objectId,
      spaceId: row.spaceId,
      privacy: row.privacy as 'open' | 'closed',
      lastMessageAt: row.lastMessageAt,
      unreadCount: 0,
      memberCount: 0,
      muted: false,
    }
  },

  async unreadCount(ctx: UserCtx, conversationId: string): Promise<number> {
    if (isGuest(ctx)) return 0
    const [member] = await db()
      .select({ lastReadMessageId: conversationMembers.lastReadMessageId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, ctx.userId),
        ),
      )
      .limit(1)

    const [row] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          member?.lastReadMessageId ? gt(messages.id, member.lastReadMessageId) : sql`true`,
          sql`${messages.authorId} <> ${ctx.userId}`,
        ),
      )
    return row?.count ?? 0
  },
}
