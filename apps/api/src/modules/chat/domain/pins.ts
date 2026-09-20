import type { ChatDraft, ChatPin } from '@kchs/contracts'
import { and, desc, eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { chatDrafts, chatPins, messages } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { loadConversation } from './chat-service.js'

/**
 * Закрепления и черновики беседы (ADR-0090). Закрепление — состояние беседы,
 * общее для всех: публикует событие. Черновик — личный и не домен: событий
 * outbox не публикует (как настройки календаря, ADR-0081).
 */
export const ChatPins = {
  async list(ctx: UserCtx, conversationId: string): Promise<ChatPin[]> {
    await authorize(ctx, 'view', conversationId)
    const rows = await db()
      .select({
        messageId: chatPins.messageId,
        pinnedBy: chatPins.pinnedBy,
        pinnedAt: chatPins.pinnedAt,
        text: messages.text,
        authorId: messages.authorId,
        deletedAt: messages.deletedAt,
      })
      .from(chatPins)
      .innerJoin(messages, eq(messages.id, chatPins.messageId))
      .where(eq(chatPins.conversationId, conversationId))
      .orderBy(desc(chatPins.pinnedAt))
      .limit(50)

    const live = rows.filter((row) => !row.deletedAt)
    const refs = await directory().refs([
      ...new Set(
        live.flatMap((row) =>
          [row.pinnedBy, row.authorId].filter((id): id is string => Boolean(id)),
        ),
      ),
    ])
    return live.map((row) => ({
      messageId: String(row.messageId),
      text: row.text,
      author: row.authorId ? (refs.get(row.authorId) ?? null) : null,
      pinnedBy: row.pinnedBy ? (refs.get(row.pinnedBy) ?? null) : null,
      pinnedAt: row.pinnedAt,
    }))
  },

  async set(
    tx: Executor,
    ctx: UserCtx,
    conversationId: string,
    messageId: number,
    on: boolean,
  ): Promise<void> {
    await authorize(ctx, 'post', conversationId)
    const conversation = await loadConversation(tx, conversationId)
    if (!conversation) throw errors.notFound('Беседа')
    const [message] = await tx
      .select({ id: messages.id, text: messages.text, conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
    if (!message || message.conversationId !== conversationId) throw errors.notFound('Сообщение')

    const changed = on
      ? await tx
          .insert(chatPins)
          .values({ conversationId, messageId, pinnedBy: ctx.userId })
          .onConflictDoNothing()
          .returning({ messageId: chatPins.messageId })
      : await tx
          .delete(chatPins)
          .where(
            and(eq(chatPins.conversationId, conversationId), eq(chatPins.messageId, messageId)),
          )
          .returning({ messageId: chatPins.messageId })
    if (changed.length === 0) return

    await publishEvent(tx, ctx, {
      type: on ? 'chat.message_pinned' : 'chat.message_unpinned',
      object: {
        id: conversationId,
        type: 'conversation',
        spaceId: conversation.spaceId,
        title: conversation.title,
      },
      payload: on
        ? { messageId: String(messageId), preview: message.text.slice(0, 200) }
        : { messageId: String(messageId) },
    })
  },
}

const threadKey = (threadRootId: string | null): number => (threadRootId ? Number(threadRootId) : 0)

export const ChatDrafts = {
  /** Все черновики смотрящего: список бесед показывает «черновик» без запроса на беседу. */
  async mine(ctx: UserCtx): Promise<ChatDraft[]> {
    const rows = await db()
      .select()
      .from(chatDrafts)
      .where(eq(chatDrafts.userId, ctx.userId))
      .orderBy(desc(chatDrafts.updatedAt))
      .limit(200)
    return rows.map((row) => ({
      conversationId: row.conversationId,
      threadRootId: row.threadRootId === 0 ? null : String(row.threadRootId),
      body: (row.body as ChatDraft['body']) ?? null,
      text: row.text,
      updatedAt: row.updatedAt,
    }))
  },

  async save(
    ctx: UserCtx,
    conversationId: string,
    input: { threadRootId: string | null; body: ChatDraft['body']; text: string },
  ): Promise<void> {
    await authorize(ctx, 'view', conversationId)
    const key = threadKey(input.threadRootId)
    if (input.text.trim().length === 0) {
      await db()
        .delete(chatDrafts)
        .where(
          and(
            eq(chatDrafts.conversationId, conversationId),
            eq(chatDrafts.userId, ctx.userId),
            eq(chatDrafts.threadRootId, key),
          ),
        )
      return
    }
    const value = {
      conversationId,
      userId: ctx.userId,
      threadRootId: key,
      body: (input.body ?? {}) as Record<string, unknown>,
      text: input.text,
      updatedAt: new Date().toISOString(),
    }
    await db()
      .insert(chatDrafts)
      .values(value)
      .onConflictDoUpdate({
        target: [chatDrafts.conversationId, chatDrafts.userId, chatDrafts.threadRootId],
        set: { body: value.body, text: value.text, updatedAt: value.updatedAt },
      })
  },
}
