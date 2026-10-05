import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Карты» (07-gis-engine.md). Домены `layer`, `map`, `feature`, `basemap`, `service_layer` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const GIS_EVENTS = {
  // ── gis: базовые карты (07-gis-engine.md §5, ADR-0066) ─────────────────────
  /** Изменились параметры подложки: адрес, ключ, масштабы, сборка (новая версия PMTiles). */
  'basemap.updated': z.object({ changed: z.array(z.string()) }),
  /** Подложка по умолчанию установки сменилась. */
  'basemap.default_changed': z.object({ previousId: Uuid.nullable() }),

  // ── gis (07-gis-engine.md, ADR-0064) ───────────────────────────────────────
  'layer.published': z.object({
    datasetId: Uuid,
    geometryType: z.enum(['point', 'line', 'polygon', 'mixed']),
  }),
  /** Стиль, поля тайла или режим правки слоя: версия слоя сменилась — тайлы заново. */
  'layer.style_changed': z.object({ changed: z.array(z.string()) }),
  'map.updated': z.object({ changed: z.array(z.string()) }),

  // ── gis: правка объектов (07-gis-engine.md §7, ADR-0076) ───────────────────
  // Объект события — слой; строка датасета — rowId, принятая правка — editId
  'feature.created': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** fields — изменённые поля (геометрия — ключом своего поля). */
  'feature.updated': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
    fields: z.array(z.string()),
  }),
  'feature.deleted': z.object({
    datasetId: Uuid,
    rowId: z.string(),
    editId: z.string().nullable(),
  }),
  /** Правка модерируемого слоя ждёт проверки. */
  'feature.edit_submitted': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),
  /** Решение по правке: принята (применена строкой датасета) или отклонена. */
  'feature.edit_reviewed': z.object({
    editId: z.string(),
    op: z.enum(['create', 'update', 'delete']),
    decision: z.enum(['approved', 'rejected']),
    datasetId: Uuid,
    rowId: z.string().nullable(),
    authorId: Uuid.nullable(),
  }),

  // ── слои-ссылки на внешние ГИС-службы (07-gis-engine.md §5, ADR-0108) ─────
  'service_layer.created': z.object({ kind: z.string() }),
  'service_layer.updated': z.object({ changed: z.array(z.string()) }),
  'service_layer.checked': z.object({ ok: z.boolean(), message: z.string() }),
} as const satisfies Record<string, z.ZodType>
