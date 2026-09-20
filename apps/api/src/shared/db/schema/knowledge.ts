import { date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbArray, tsCol, updatedAt } from './_shared.js'
import { users } from './identity.js'
import { objects } from './kernel.js'

/**
 * База знаний (13-search-knowledge-ai.md §2, ADR-0095). Название, дерево,
 * пространство, владелец, теги и жизненный цикл — в реестре `objects`; здесь —
 * снимок блоков совместного документа, состояние, срок пересмотра и версии.
 */
export const pages = pgTable(
  'pages',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** `draft` — черновик, `published` — опубликована, `review` — на пересмотре. */
    status: text('status').notNull().default('draft'),
    /** Шаблон, по которому страница заведена (`blank` — с нуля). */
    template: text('template').notNull().default('blank'),
    /** Снимок блоков документа Yjs — его пишет сервер совместного редактирования. */
    blocks: jsonbArray('blocks'),
    /**
     * Владелец страницы: отвечает за её пересмотр, ему открывается дело
     * «Пересмотреть страницу». По умолчанию — автор; меняется отдельно от
     * владельца объекта в реестре (тот определяет права, этот — ответственность).
     */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    /** Срок пересмотра: наступил — страница уходит в `review`, владельцу — дело. */
    reviewAt: date('review_at'),
    /** Дело о пересмотре открыто на этот срок — повторно его не открывают. */
    reviewOpenedFor: date('review_opened_for'),
    publishedAt: tsCol('published_at'),
    publishedBy: uuid('published_by').references(() => users.id, { onDelete: 'set null' }),
    /** Номер последней версии; 0 — версий ещё нет. */
    versionNumber: integer('version_number').notNull().default(0),
    /** Ознакомление запрошено (учёт ведёт ядро, ADR-0084). */
    acknowledgmentAt: tsCol('acknowledgment_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('pages_status_idx').on(t.status), index('pages_review_idx').on(t.reviewAt)],
)

/**
 * Версия страницы: снимок блоков при публикации, по кнопке и перед откатом.
 * Сравнение версий — по их тексту (`shared/text-diff.ts`).
 */
export const pageVersions = pgTable(
  'page_versions',
  {
    id: uuid('id').primaryKey(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    /** Название страницы на момент снимка. */
    title: text('title').notNull(),
    blocks: jsonbArray('blocks'),
    /** `publish` — публикация, `manual` — кнопка, `restore` — снимок перед откатом. */
    reason: text('reason').notNull().default('manual'),
    note: text('note'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('page_versions_number_uq').on(t.pageId, t.number),
    index('page_versions_page_idx').on(t.pageId, t.number),
  ],
)
