import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Происхождение и влияние (06-analytics-engine.md §15, ADR-0102): граф
 * вычисляемых зависимостей «использует» вокруг объекта. Видно только то, что
 * доступно смотрящему: невидимые узлы выпадают вместе со своими рёбрами.
 */

export const LineageNode = z.object({
  objectId: Uuid,
  type: z.string(),
  title: z.string(),
  url: z.string(),
  icon: z.string().nullable(),
  /** 0 — сам объект, отрицательные — источники, положительные — потребители. */
  depth: z.number().int(),
})
export type LineageNode = z.infer<typeof LineageNode>

export const LineageEdge = z.object({
  /** Кто использует. */
  from: Uuid,
  /** Что используется. */
  to: Uuid,
  kind: z.string(),
})
export type LineageEdge = z.infer<typeof LineageEdge>

export const LineageQuery = z.object({
  /** Сколько шагов в каждую сторону. */
  depth: z.coerce.number().int().min(1).max(5).default(3),
})
export type LineageQuery = z.infer<typeof LineageQuery>

export const ObjectLineage = z.object({
  nodes: z.array(LineageNode),
  edges: z.array(LineageEdge),
  /** Граф обрезан по глубине: дальше есть ещё. */
  truncated: z.boolean(),
})
export type ObjectLineage = z.infer<typeof ObjectLineage>
