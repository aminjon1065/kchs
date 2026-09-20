import {
  bigserial,
  customType,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tsCol, updatedAt } from './_shared.js'
import { objects } from './kernel.js'

/** Размерность модели `bge-m3` (05-data-model.md): вектор фиксированной длины. */
export const EMBEDDING_DIM = 1024

/** Вектор pgvector: тип задаётся размерностью, сравнение — косинусное. */
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value) => `[${value.join(',')}]`,
    fromDriver: (value) => JSON.parse(value) as number[],
  })(name)

/**
 * Векторы объектов для поиска по смыслу (13-search-knowledge-ai.md §1,
 * ADR-0099): текст объекта режется на куски, каждый кусок — строка с вектором.
 * Права здесь не хранятся: выдачу режет предикат видимости ядра по `object_id`.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    chunkNo: integer('chunk_no').notNull(),
    /** Текст куска — он же цитата в ответе ассистента. */
    text: text('text').notNull(),
    embedding: vector('embedding', EMBEDDING_DIM).notNull(),
    /** Какой моделью посчитан: смена модели обесценивает старые векторы. */
    model: text('model').notNull(),
    updatedAt: updatedAt(),
    /** Хэш текста: не пересчитываем вектор, если кусок не изменился. */
    hash: text('hash').notNull(),
    indexedAt: tsCol('indexed_at'),
  },
  (t) => [
    uniqueIndex('embeddings_object_chunk_idx').on(t.objectId, t.chunkNo),
    index('embeddings_object_idx').on(t.objectId),
  ],
)
