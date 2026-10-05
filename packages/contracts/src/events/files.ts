import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Файлы» (09-files.md). Домены `file` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const FILES_EVENTS = {
  // ── files ─────────────────────────────────────────────────────────────────
  'file.uploaded': z.object({ name: z.string(), size: z.number(), mime: z.string() }),
  'file.version_added': z.object({ versionId: Uuid, number: z.number().int() }),
  'file.text_extracted': z.object({ chars: z.number().int() }),
  'file.previewed': z.object({ status: z.string() }),
  'file.shared_link_created': z.object({ linkId: Uuid }),
  'file.downloaded': z.object({ versionId: Uuid.nullable() }),
} as const satisfies Record<string, z.ZodType>
