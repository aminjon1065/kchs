import type { LineageEdge, LineageNode, ObjectLineage } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { dependencies, objects } from '~/shared/db/schema/index.js'
import { visibleObjectsSql } from '../access/authorize.js'
import { objectType } from '../objects/registry.js'

/**
 * Происхождение и влияние (ADR-0102): обход графа `dependencies` в обе стороны
 * от объекта. Невидимые смотрящему узлы в граф не попадают — вместе со своими
 * рёбрами, поэтому чужой дашборд не выдаёт себя даже ребром.
 */

/** Предел узлов: граф в контекстной панели должен читаться человеком. */
const MAX_NODES = 60

interface Step {
  from: string
  to: string
  kind: string
}

/** Соседи по зависимостям: `up` — что объект использует, `down` — кто использует его. */
async function neighbours(ctx: Ctx, ids: string[], direction: 'up' | 'down'): Promise<Step[]> {
  if (ids.length === 0) return []
  const rows = await db()
    .select({
      from: dependencies.fromId,
      to: dependencies.toId,
      kind: dependencies.kind,
    })
    .from(dependencies)
    .innerJoin(
      objects,
      eq(objects.id, direction === 'up' ? dependencies.toId : dependencies.fromId),
    )
    .where(
      and(
        direction === 'up' ? inArray(dependencies.fromId, ids) : inArray(dependencies.toId, ids),
        sql`${objects.deletedAt} is null`,
        visibleObjectsSql(ctx),
      ),
    )
  return rows
}

export async function lineageOf(ctx: Ctx, objectId: string, depth: number): Promise<ObjectLineage> {
  const seen = new Map<string, number>([[objectId, 0]])
  const edges: LineageEdge[] = []
  let truncated = false

  for (const direction of ['up', 'down'] as const) {
    let frontier = [objectId]
    for (let step = 1; step <= depth && frontier.length > 0; step += 1) {
      const rows = await neighbours(ctx, frontier, direction)
      const next: string[] = []
      for (const row of rows) {
        const neighbour = direction === 'up' ? row.to : row.from
        edges.push({ from: row.from, to: row.to, kind: row.kind })
        if (seen.has(neighbour)) continue
        if (seen.size >= MAX_NODES) {
          truncated = true
          continue
        }
        seen.set(neighbour, direction === 'up' ? -step : step)
        next.push(neighbour)
      }
      frontier = next
      if (frontier.length > 0 && step === depth) truncated = true
    }
  }

  const rows = await db()
    .select({ id: objects.id, type: objects.type, title: objects.title })
    .from(objects)
    .where(inArray(objects.id, [...seen.keys()]))

  const nodes: LineageNode[] = rows.map((row) => {
    const definition = objectType(row.type)
    return {
      objectId: row.id,
      type: row.type,
      title: row.title,
      url: definition?.route(row.id) ?? `/o/${row.id}`,
      icon: definition?.icon ?? null,
      depth: seen.get(row.id) ?? 0,
    }
  })

  const known = new Set(nodes.map((node) => node.objectId))
  // Ребро в невидимый узел не показываем: оно раскрыло бы его существование
  const visibleEdges = edges.filter((edge) => known.has(edge.from) && known.has(edge.to))
  const unique = new Map(visibleEdges.map((edge) => [`${edge.from}|${edge.to}|${edge.kind}`, edge]))

  return { nodes, edges: [...unique.values()], truncated }
}
