import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Автоматизация» (14-automation-integrations.md). Домены `rule` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const AUTOMATION_EVENTS = {
  // ── автоматизация: правила и входящие вызовы (ADR-0096) ────────────────────
  'rule.created': z.object({ key: z.string(), triggerKind: z.string() }),
  'rule.updated': z.object({ key: z.string(), changed: z.array(z.string()).default([]) }),
  'rule.enabled': z.object({ key: z.string() }),
  'rule.disabled': z.object({ key: z.string() }),
  /** Запуск правила окончательно не выполнен: владелец получает уведомление. */
  'rule.run_failed': z.object({
    runId: Uuid,
    ruleId: Uuid,
    error: z.string(),
    actionIndex: z.number().int().nullable().default(null),
  }),
} as const satisfies Record<string, z.ZodType>
