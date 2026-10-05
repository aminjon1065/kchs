import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Знания» (13-search-knowledge-ai.md §2). Домены `page` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const KNOWLEDGE_EVENTS = {
  // ── база знаний (13-search-knowledge-ai.md §2, ADR-0095) ───────────────────
  /** Снимок страницы после совместной правки: блоки изменились. */
  'page.updated': z.object({ changed: z.array(z.enum(['blocks'])) }),
  /** Страница опубликована: снимок стал версией, срок пересмотра назначен. */
  'page.published': z.object({
    versionId: Uuid,
    number: z.number().int(),
    reviewAt: z.string().nullable(),
  }),
  /**
   * Состояние страницы изменилось. `cause`: `publish` — публикация,
   * `review_due` — наступил срок пересмотра, `manual` — владелец вернул в работу.
   */
  'page.status_changed': z.object({
    from: z.string(),
    to: z.string(),
    cause: z.enum(['publish', 'review_due', 'manual']),
  }),
  /** Снимок страницы сохранён версией: публикация, кнопка «Сохранить версию», откат. */
  'page.version_created': z.object({
    versionId: Uuid,
    number: z.number().int(),
    reason: z.enum(['publish', 'manual', 'restore']),
  }),
  /** Страница откачена к версии: её текст стал текущим (перед откатом снят снимок). */
  'page.restored': z.object({ versionId: Uuid, number: z.number().int() }),
  /** Срок пересмотра наступил: страница ушла на пересмотр, владельцу — дело. */
  'page.review_due': z.object({ reviewAt: z.string(), ownerId: Uuid.nullable() }),
} as const satisfies Record<string, z.ZodType>
