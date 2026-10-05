import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Задания (02-platform-kernel.md §9). Домены `job` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const JOB_EVENTS = {
  // ── jobs ──────────────────────────────────────────────────────────────────
  'job.queued': z.object({ jobId: Uuid, queue: z.string(), name: z.string() }),
  'job.started': z.object({ jobId: Uuid }),
  'job.finished': z.object({ jobId: Uuid, durationMs: z.number().int() }),
  'job.failed': z.object({ jobId: Uuid, error: z.string() }),
  /** Задание отменено до завершения (ADR-0172); актор — кто отменил. */
  'job.cancelled': z.object({ jobId: Uuid }),
} as const satisfies Record<string, z.ZodType>
