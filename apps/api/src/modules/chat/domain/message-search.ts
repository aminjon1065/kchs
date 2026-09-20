import type {
  ChatSearchHit,
  ChatSearchQuery,
  ChatSearchResponse,
  ConversationKind,
} from '@kchs/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { meili, meiliValue } from '~/kernel/search/index-service.js'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { conversations, messages, objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { ChatService } from './chat-service.js'

/**
 * Поиск сообщений (ADR-0090). По одной беседе ищет Postgres (индекс триграмм
 * `messages_text_trgm`): найденное видно сразу после отправки. Глобальный
 * поиск — отдельный индекс Meilisearch `messages`; права применяются фильтром
 * по беседам смотрящего, поэтому переиндексация при смене состава не нужна.
 */
interface MessageDocument {
  id: string
  conversationId: string
  authorId: string | null
  text: string
  createdAt: number
}

export function messagesIndexName(): string {
  return `${config().MEILI_INDEX_PREFIX}messages`
}

const index = () => meili().index<MessageDocument>(messagesIndexName())

export async function ensureMessageIndex(): Promise<void> {
  try {
    await meili().createIndex(messagesIndexName(), { primaryKey: 'id' })
  } catch {
    // индекс уже существует
  }
  await index().updateSettings({
    searchableAttributes: ['text'],
    filterableAttributes: ['conversationId', 'authorId', 'createdAt'],
    sortableAttributes: ['createdAt'],
    pagination: { maxTotalHits: 2000 },
  })
}

export async function indexMessage(messageId: number): Promise<void> {
  const [row] = await db()
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      authorId: messages.authorId,
      text: messages.text,
      createdAt: messages.createdAt,
      deletedAt: messages.deletedAt,
      kind: messages.kind,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  if (!row || row.deletedAt || row.kind === 'system' || row.text.length === 0) {
    await removeMessageFromIndex(messageId)
    return
  }
  await index().addDocuments([
    {
      id: String(row.id),
      conversationId: row.conversationId,
      authorId: row.authorId,
      text: row.text.slice(0, 20_000),
      createdAt: Math.floor(new Date(row.createdAt).getTime() / 1000),
    },
  ])
}

export async function removeMessageFromIndex(messageId: number): Promise<void> {
  await index()
    .deleteDocument(String(messageId))
    .catch(() => undefined)
}

/** Фрагмент вокруг совпадения с подсветкой — как у поиска объектов. */
function snippetOf(text: string, needle: string, radius = 60): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return escapeHtml(text.slice(0, radius * 2))
  const from = Math.max(0, at - radius)
  const to = Math.min(text.length, at + needle.length + radius)
  const head = from > 0 ? '…' : ''
  const tail = to < text.length ? '…' : ''
  return (
    head +
    escapeHtml(text.slice(from, at)) +
    `<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>` +
    escapeHtml(text.slice(at + needle.length, to)) +
    tail
  )
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

interface Found {
  messageId: string
  conversationId: string
  authorId: string | null
  text: string
  createdAt: string
}

async function inConversation(query: ChatSearchQuery, conversationId: string): Promise<Found[]> {
  const rows = await db()
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      authorId: messages.authorId,
      text: messages.text,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.deletedAt),
        sql`${messages.text} ILIKE ${`%${query.q}%`}`,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(query.limit)
    .offset(query.offset)
  return rows.map((row) => ({
    messageId: String(row.id),
    conversationId: row.conversationId,
    authorId: row.authorId,
    text: row.text,
    createdAt: row.createdAt,
  }))
}

async function globally(ctx: UserCtx, query: ChatSearchQuery): Promise<Found[]> {
  const conversationIds = await ChatService.myConversationIds(ctx.userId)
  if (conversationIds.length === 0) return []
  const filter = `(${conversationIds.map((id) => `conversationId = ${meiliValue(id)}`).join(' OR ')})`
  try {
    const result = await index().search(query.q, {
      limit: query.limit,
      offset: query.offset,
      filter,
      sort: ['createdAt:desc'],
    })
    return result.hits.map((hit) => ({
      messageId: hit.id,
      conversationId: hit.conversationId,
      authorId: hit.authorId,
      text: hit.text,
      createdAt: new Date(hit.createdAt * 1000).toISOString(),
    }))
  } catch (error) {
    logger().warn({ err: error }, 'поиск сообщений недоступен')
    return []
  }
}

export const MessageSearch = {
  async run(ctx: UserCtx, query: ChatSearchQuery): Promise<ChatSearchResponse> {
    if (query.conversationId) await authorize(ctx, 'view', query.conversationId)
    const found = query.conversationId
      ? await inConversation(query, query.conversationId)
      : await globally(ctx, query)
    if (found.length === 0) return { hits: [], total: 0 }

    const conversationIds = [...new Set(found.map((item) => item.conversationId))]
    const titles = await db()
      .select({ id: conversations.id, kind: conversations.kind, title: objects.title })
      .from(conversations)
      .innerJoin(objects, eq(objects.id, conversations.id))
      .where(sql`${conversations.id} = ANY(${conversationIds}::uuid[])`)
    const byId = new Map(titles.map((row) => [row.id, row]))
    const refs = await directory().refs([
      ...new Set(found.map((item) => item.authorId).filter((id): id is string => Boolean(id))),
    ])

    const hits: ChatSearchHit[] = found.map((item) => {
      const conversation = byId.get(item.conversationId)
      return {
        messageId: item.messageId,
        conversationId: item.conversationId,
        conversationTitle: conversation?.title ?? '',
        conversationKind: (conversation?.kind ?? 'group') as ConversationKind,
        author: item.authorId ? (refs.get(item.authorId) ?? null) : null,
        snippet: snippetOf(item.text, query.q),
        createdAt: item.createdAt,
      }
    })
    return { hits, total: hits.length }
  },
}
