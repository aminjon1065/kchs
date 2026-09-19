import {
  canTransition,
  type DocumentStatus,
  type DocumentTransitionCause,
  isDocumentClosed,
} from '@kchs/contracts'
import { eq, sql } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { documents, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

export interface TransitionInput {
  to: DocumentStatus
  cause: DocumentTransitionCause
  /** Источник перехода для события: экземпляр процесса, резолюция. */
  source?: { kind: string; id: string } | null
}

/**
 * Единственная точка смены статуса документа (08-documents.md §3, ADR-0080).
 * Переход проверяется по графу жизненного цикла; ручной смены статуса нет —
 * вызывают доменные действия (регистрация, аннулирование) и, во второй волне,
 * движок процессов через `DocumentsPublic.applyTransition`. Строка документа
 * блокируется: параллельные переходы не проскакивают граф.
 */
export async function applyTransition(
  tx: Executor,
  ctx: Ctx,
  documentId: string,
  input: TransitionInput,
): Promise<{ from: DocumentStatus; to: DocumentStatus }> {
  const [row] = await tx
    .select({ status: documents.status })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)
    .for('update')
  if (!row) throw errors.notFound('Документ')
  const from = row.status as DocumentStatus
  if (!canTransition(from, input.to)) {
    throw errors.conflict('Переход недопустим для текущего статуса документа', {
      from,
      to: input.to,
    })
  }

  await tx
    .update(documents)
    .set({
      status: input.to,
      ...(input.to === 'executed' ? { executedAt: sql`now()` } : {}),
      ...(input.to === 'archived' ? { archivedAt: sql`now()` } : {}),
      ...(input.to === 'cancelled' ? { cancelledAt: sql`now()` } : {}),
    })
    .where(eq(documents.id, documentId))

  // Статус — в сводных полях реестра: списки и фильтры объектов
  await ObjectService.update(
    tx,
    ctx,
    documentId,
    { meta: { status: input.to, closed: isDocumentClosed(input.to) }, mergeMeta: true },
    { silent: true },
  )

  const [object] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, documentId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'document.status_changed',
    object: {
      id: documentId,
      type: 'document',
      spaceId: object?.spaceId ?? null,
      title: object?.title ?? null,
    },
    payload: {
      from,
      to: input.to,
      cause: input.cause,
      ...(input.source ? { source: input.source } : {}),
    },
  })
  return { from, to: input.to }
}
