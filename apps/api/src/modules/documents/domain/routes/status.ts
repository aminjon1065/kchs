import type { DocumentStatus } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { documents } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { applyTransition } from '../lifecycle.js'

/** Статус, к которому ведёт шаг маршрута (08-documents.md §3). */
export type RouteTarget = 'on_approval' | 'approved' | 'on_signing' | 'signed' | 'returned'

/**
 * Переходы от статуса к цели маршрута — рёбра графа жизненного цикла: только
 * то, что действительно произошло. «Согласован» — промежуточный статус между
 * согласованием и подписью.
 */
const PATHS: Record<RouteTarget, Partial<Record<DocumentStatus, DocumentStatus[]>>> = {
  on_approval: { draft: ['on_approval'], returned: ['on_approval'], on_approval: [] },
  approved: { on_approval: ['approved'], approved: [] },
  on_signing: {
    draft: ['on_signing'],
    returned: ['on_signing'],
    on_approval: ['approved', 'on_signing'],
    approved: ['on_signing'],
    on_signing: [],
  },
  signed: { on_signing: ['signed'], signed: [] },
  returned: { on_approval: ['returned'], on_signing: ['returned'], returned: [] },
}

/** Порядок статусов по ходу маршрута: документ, ушедший дальше цели, не откатывается. */
const RANK: Partial<Record<DocumentStatus, number>> = {
  draft: 0,
  returned: 1,
  on_approval: 2,
  approved: 3,
  on_signing: 4,
  signed: 5,
  registered: 6,
  on_execution: 7,
  executed: 8,
  filed: 9,
  archived: 10,
}

export async function currentStatus(
  executor: Executor,
  documentId: string,
): Promise<DocumentStatus> {
  const [row] = await executor
    .select({ status: documents.status })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
  if (!row) throw errors.notFound('Документ')
  return row.status as DocumentStatus
}

/**
 * Статус документа по шагу маршрута (ADR-0083) — через `applyTransition`, с
 * причиной `process` и источником-экземпляром. Хуки движка вызываются и
 * повторно (завершение шага после решения): совпадение и уже пройденная цель
 * ничего не меняют. Маршрут, противоречащий графу (согласование после подписи,
 * регистрация без подписи), останавливается ошибкой, а не портит статус.
 */
export async function ensureRouteStatus(
  tx: Executor,
  ctx: Ctx,
  documentId: string,
  target: RouteTarget,
  instanceId: string,
): Promise<void> {
  const from = await currentStatus(tx, documentId)
  const path = PATHS[target][from]
  if (!path) {
    // Документ уже дальше цели (зарегистрирован в том же переходе) — ничего не делаем
    const ahead = (RANK[from] ?? -1) > (RANK[target] ?? Number.MAX_SAFE_INTEGER)
    if (ahead && target !== 'returned') return
    throw errors.conflict('Шаг маршрута противоречит статусу документа', {
      from,
      to: target,
      reason: 'route_status',
    })
  }
  for (const to of path) {
    await applyTransition(tx, ctx, documentId, {
      to,
      cause: 'process',
      source: { kind: 'process', id: instanceId },
    })
  }
}
