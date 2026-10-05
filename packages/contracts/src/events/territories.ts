import { z } from 'zod'

/**
 * События: Модуль «Территории» (ADR-0180). Домены `territory` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const TERRITORIES_EVENTS = {
  // ── territories (07-gis-engine.md §11, ADR-0067) ──────────────────────────
  /** Граница единицы справочника изменилась: changedFields — geom, centroid, areaKm2. */
  'territory.updated': z.object({ code: z.string() }),
} as const satisfies Record<string, z.ZodType>
