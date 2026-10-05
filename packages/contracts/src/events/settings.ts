import { z } from 'zod'

/**
 * События: Настройки и объявления установки. Домены `settings`, `announcement` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const SETTINGS_EVENTS = {
  // ── admin ─────────────────────────────────────────────────────────────────
  'settings.changed': z.object({ scope: z.string(), key: z.string() }),
  /** День производственного календаря изменён или удалён (`kind: null`). */
  'settings.business_calendar_changed': z.object({
    country: z.string(),
    day: z.string(),
    kind: z.string().nullable(),
  }),
  'announcement.published': z.object({ title: z.string() }),
  'announcement.withdrawn': z.object({ title: z.string() }),
} as const satisfies Record<string, z.ZodType>
