import type { AssistantCitation, AssistantProposal, AssistantStep } from '@kchs/contracts'
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * Диалоги с ассистентом (13-search-knowledge-ai.md §5, ADR-0100): у каждого
 * пользователя своя ветка на объект. Чужую ветку не видит никто: ассистент
 * отвечает правами спрашивающего, и его переписка — его личная.
 */
export const assistantThreads = pgTable(
  'assistant_threads',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Объект разговора; null — общий диалог (палитра, «Спросить»). */
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('assistant_threads_user_idx').on(t.userId, t.objectId, t.updatedAt)],
)

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => assistantThreads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    text: text('text').notNull(),
    /** Что ассистент делал: инструмент, пояснение, сколько нашёл. */
    steps: jsonb('steps').$type<AssistantStep[]>().notNull().default([]),
    /** Ссылки на объекты, на которые опирался ответ. */
    citations: jsonb('citations').$type<AssistantCitation[]>().notNull().default([]),
    /** Предложения действий — выполняет их человек. */
    proposals: jsonb('proposals').$type<AssistantProposal[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index('assistant_messages_thread_idx').on(t.threadId, t.createdAt)],
)
