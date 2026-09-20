/**
 * Публичный API модуля «База знаний» для других модулей и служебных команд
 * (01-overview.md §Как модули взаимодействуют, ADR-0095):
 *
 *  - `KnowledgeSemantics.setSource` — подключение источника поиска по смыслу
 *    (эмбеддинги, pgvector): без него база знаний ищет только словами;
 *  - `KnowledgeSeed.ensureDefaultSections` — разделы по умолчанию (`db:seed`).
 */
import { ensureDefaultSections } from './domain/page-seed.js'
import { type SemanticSource, setSemanticSource } from './domain/semantic-port.js'

/** @public — типы источника поиска по смыслу (ADR-0095) */
export type {
  SemanticChunk,
  SemanticHit,
  SemanticQuery,
  SemanticSource,
} from './domain/semantic-port.js'

/** @public — источник поиска по смыслу подключается при старте (ADR-0095) */
export const KnowledgeSemantics = {
  setSource: (source: SemanticSource | null): void => setSemanticSource(source),
}

/** @public — разделы базы знаний по умолчанию для `db:seed` */
export const KnowledgeSeed = { ensureDefaultSections }
