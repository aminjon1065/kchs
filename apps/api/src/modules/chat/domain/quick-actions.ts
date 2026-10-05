import type { ChatForwardInput, ChatTaskInput, RichBody } from '@kchs/contracts'
import { authorize } from '~/kernel/access/authorize.js'
import { DiscussionQueries, type MessageRef } from '~/kernel/discussions/queries.js'
import { DiscussionService } from '~/kernel/discussions/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { startCall } from '~/modules/meetings/public.js'
import { Instructions } from '~/modules/tasks/public.js'
import type { UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { ChatService, loadConversation } from './chat-service.js'
import { CHATS_SPACE_KEY } from './space.js'

async function loadMessage(executor: Executor, messageId: number): Promise<MessageRef> {
  const row = await DiscussionQueries.message(executor, messageId)
  if (!row) throw errors.notFound('Сообщение')
  return row
}

/** Тело пересланного сообщения: цитата исходного и, при желании, свой комментарий. */
function quoteBody(quote: string, comment?: string): RichBody {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }],
    },
  ]
  if (comment) content.push({ type: 'paragraph', content: [{ type: 'text', text: comment }] })
  return { type: 'doc', content }
}

/** Системное пространство чатов не место для поручений: они живут у автора. */
async function taskSpaceId(
  tx: Executor,
  ctx: UserCtx,
  conversationSpaceId: string | null,
): Promise<string | undefined> {
  if (!conversationSpaceId) return undefined
  if ((await SpaceService.keyOf(conversationSpaceId, tx)) !== CHATS_SPACE_KEY) return undefined
  // Личное пространство уже есть у каждого: создавать его здесь нельзя —
  // `authorize` читает объект вне транзакции и не увидел бы новую запись
  return (await SpaceService.personalOf(ctx.userId, tx)) ?? undefined
}

/**
 * Быстрые действия из сообщения (11-communications-meetings.md §1, ADR-0090):
 * поручение с цитатой и связью `source`, связь сообщения с документом, звонок
 * из беседы и пересылка.
 */
export const QuickActions = {
  /** Поручение по сообщению: источник — обсуждаемый объект или сама беседа. */
  async task(
    tx: Executor,
    ctx: UserCtx,
    messageId: number,
    input: ChatTaskInput,
  ): Promise<{ taskId: string; key: string }> {
    const message = await loadMessage(tx, messageId)
    await authorize(ctx, 'view', message.conversationId)
    const conversation = await loadConversation(tx, message.conversationId)
    if (!conversation) throw errors.notFound('Беседа')

    const sourceObjectId = conversation.objectId ?? conversation.id
    const spaceId = conversation.objectId
      ? undefined
      : await taskSpaceId(tx, ctx, conversation.spaceId)

    const created = await Instructions.create(tx, ctx, {
      title: input.title,
      description: message.text.slice(0, 4000),
      source: { kind: 'object', objectId: sourceObjectId },
      assigneeId: input.assigneeId ?? ctx.userId,
      due: input.dueAt ? { at: input.dueAt } : { workingDays: input.dueWorkingDays },
      priority: input.priority,
      ...(spaceId ? { spaceId } : {}),
    })

    // Цитата остаётся в беседе сообщением-действием. Упоминанием поручение не
    // оформляется: `authorize` читает объект вне транзакции и не увидел бы его
    await DiscussionService.post(
      tx,
      ctx,
      message.conversationId,
      {
        body: quoteBody(message.text.slice(0, 500)),
        text: `${created.key}: ${input.title}`,
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
        replyToId: String(messageId),
        threadRootId: null,
      },
      'action',
      { meta: { taskId: created.id, taskKey: created.key } },
    )
    return { taskId: created.id, key: created.key }
  },

  /** Прикрепить сообщение к документу или другому объекту — связь ядра. */
  async attach(tx: Executor, ctx: UserCtx, messageId: number, objectId: string): Promise<void> {
    const message = await loadMessage(tx, messageId)
    await authorize(ctx, 'view', message.conversationId)
    // Связь заводит тот, кто вправе править объект-хозяин
    await authorize(ctx, 'edit', objectId)
    await LinkService.link(tx, ctx, objectId, message.conversationId, 'related', {
      messageId: String(messageId),
      preview: message.text.slice(0, 200),
    })
  },

  /** Звонок из беседы: участники беседы — участники звонка (модуль встреч, ADR-0089). */
  async call(tx: Executor, ctx: UserCtx, conversationId: string, title?: string): Promise<string> {
    await authorize(ctx, 'post', conversationId)
    const conversation = await loadConversation(tx, conversationId)
    if (!conversation) throw errors.notFound('Беседа')
    const participantIds = await ChatService.memberIds(conversationId, tx)
    const meetingId = await startCall(tx, ctx, {
      title: title?.trim() || conversation.title,
      conversationId,
      participantIds: participantIds.length > 0 ? participantIds : [ctx.userId],
    })
    // След в ленте — сообщение-действие с идентификатором встречи в `meta`:
    // свой текст интерфейс подставляет по виду сообщения, сервер подписей не
    // сочиняет, а упоминание встречи в этой же транзакции ещё не проверяемо
    await DiscussionService.post(
      tx,
      ctx,
      conversationId,
      {
        body: quoteBody(''),
        text: '',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
      'action',
      { meta: { meetingId } },
    )
    return meetingId
  },

  /** Пересылка: в каждой беседе-получателе появляется цитата исходного сообщения. */
  async forward(tx: Executor, ctx: UserCtx, input: ChatForwardInput): Promise<{ posted: number }> {
    const ids = input.messageIds.map(Number).filter((id) => Number.isInteger(id))
    if (ids.length === 0) throw errors.validation('Нечего пересылать')
    // Удалённое сообщение не пересылается: от него осталась только строка
    const rows = await DiscussionQueries.messages(tx, ids, { live: true })
    if (rows.length === 0) throw errors.notFound('Сообщение')

    for (const source of new Set(rows.map((row) => row.conversationId))) {
      await authorize(ctx, 'view', source)
    }
    for (const target of input.toConversationIds) await authorize(ctx, 'post', target)

    let posted = 0
    for (const target of input.toConversationIds) {
      for (const [at, row] of rows.entries()) {
        // Пометка «переслано» — в свободном поле сообщения: список и карточка
        // показывают источник, а текст остаётся пригодным для поиска
        await DiscussionService.post(
          tx,
          ctx,
          target,
          {
            body: quoteBody(row.text, at === 0 ? input.comment : undefined),
            text: row.text.slice(0, 20_000),
            attachments: [],
            mentions: [],
            mentionedObjectIds: [],
          },
          'user',
          {
            meta: {
              forwardedFrom: {
                messageId: String(row.id),
                conversationId: row.conversationId,
                authorId: row.authorId,
                createdAt: row.createdAt,
              },
            },
          },
        )
        posted += 1
      }
    }

    const [first] = rows
    const source = first ? await loadConversation(tx, first.conversationId) : null
    await publishEvent(tx, ctx, {
      type: 'chat.messages_forwarded',
      object: source
        ? {
            id: source.id,
            type: 'conversation',
            spaceId: source.spaceId,
            title: source.title,
          }
        : null,
      payload: {
        messageIds: rows.map((row) => String(row.id)),
        targetIds: [...input.toConversationIds],
      },
    })
    return { posted }
  },
}
