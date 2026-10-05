import { z } from 'zod'
import { Uuid } from '../common/primitives.js'
import { empty } from './shared.js'

/**
 * События: Модуль «Алерты» (06-analytics-engine.md §14). Домены `alert` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const ALERTS_EVENTS = {
  // ── алерты на показатели (06-analytics-engine.md §14, ADR-0104) ───────────
  'alert.created': z.object({ metricId: Uuid, condition: z.string() }),
  'alert.updated': z.object({ changed: z.array(z.string()).default([]) }),
  'alert.enabled': z.object({ cron: z.string() }),
  'alert.disabled': empty,
  /** Условие выполнено: уведомления, Входящие и правила автоматизации. */
  'alert.fired': z.object({
    alertId: Uuid,
    eventId: Uuid,
    metricId: Uuid,
    metricName: z.string(),
    condition: z.string(),
    /** Ключ разреза; пустая строка — показатель целиком. */
    groupKey: z.string().default(''),
    groupLabel: z.string().default(''),
    value: z.number().nullable().default(null),
    base: z.number().nullable().default(null),
    score: z.number().nullable().default(null),
    message: z.string(),
  }),
} as const satisfies Record<string, z.ZodType>
