import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Отчёты» (06-analytics-engine.md §12). Домены `report` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const REPORTS_EVENTS = {
  // ── reports (06-analytics-engine.md §12, ADR-0078) ─────────────────────────
  /** Снимок шаблона после совместной правки: блоки, параметры, настройки печати. */
  'report.updated': z.object({
    changed: z.array(z.enum(['blocks', 'params', 'settings', 'template'])),
  }),
  /** Версия шаблона отчёта: вручную, при формировании или перед откатом (ADR-0164). */
  'report.version_saved': z.object({
    versionId: Uuid,
    number: z.number().int(),
    reason: z.enum(['manual', 'run', 'restore']),
  }),
  /** Запуск рендера поставлен: «Сформировать» или расписание (по запуску на получателя). */
  'report.run_queued': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
  }),
  /** Движок открыл страницу печати: запуск идёт. */
  'report.run_started': z.object({ runId: Uuid, attempt: z.number().int() }),
  /** Файлы отчёта готовы в бакете экспортов. */
  'report.generated': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
    formats: z.array(z.string()),
    pages: z.number().int().nullable(),
    size: z.number().int(),
  }),
  /** Рендер не выполнен; skipped — получатель потерял доступ к отчёту. */
  'report.run_failed': z.object({
    runId: Uuid,
    trigger: z.enum(['manual', 'schedule']),
    runAs: Uuid,
    error: z.string(),
    skipped: z.boolean(),
  }),
  /** Расписание рассылки задано, изменено или снято (enabled: false, frequency: null). */
  'report.schedule_changed': z.object({
    enabled: z.boolean(),
    frequency: z.string().nullable(),
    recipients: z.number().int(),
  }),
  /** Отчёт доставлен получателю: итог по каналам (sent, unavailable, failed). */
  'report.delivered': z.object({
    runId: Uuid,
    userId: Uuid,
    channels: z.record(z.string(), z.string()),
  }),
} as const satisfies Record<string, z.ZodType>
