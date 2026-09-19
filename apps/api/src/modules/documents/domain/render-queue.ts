import {
  type Confidentiality,
  type DocumentRenderKind,
  parseConfidentiality,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { documentRenders, objects } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'

/**
 * Задание движка рендеров модуля документов (ADR-0085): в данных — только
 * идентификатор рендера; план движок берёт у api, когда начинает работу.
 */
export const RENDER_JOB = { queue: 'render', name: 'document.render' } as const

export type RenderRow = typeof documentRenders.$inferSelect

/** Объект рендера: документ, журнал, шаблон или файл. */
export interface RenderSubject {
  id: string
  type: string
  spaceId: string
  title: string
  confidentiality: Confidentiality
}

export async function loadSubject(executor: Executor, id: string): Promise<RenderSubject | null> {
  const [row] = await executor
    .select({
      id: objects.id,
      type: objects.type,
      spaceId: objects.spaceId,
      title: objects.title,
      confidentiality: objects.confidentiality,
      deletedAt: objects.deletedAt,
    })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  if (!row?.spaceId || row.deletedAt) return null
  return {
    id: row.id,
    type: row.type,
    spaceId: row.spaceId,
    title: row.title,
    confidentiality: parseConfidentiality(row.confidentiality, 'public'),
  }
}

export interface EnqueueRenderInput {
  kind: DocumentRenderKind
  subject: RenderSubject
  formKey: string | null
  params?: Record<string, unknown>
  requestedBy: string | null
  /** Файл результата — его идентификаторы выдаются сразу (печать, заполнение). */
  withFile?: boolean
  dedupeKey?: string
}

/** Заказ рендера в транзакции вызывающего: строка, задание движка, событие. */
export async function enqueueRender(
  tx: Executor,
  ctx: Ctx,
  input: EnqueueRenderInput,
): Promise<string> {
  const id = newId()
  await tx.insert(documentRenders).values({
    id,
    kind: input.kind,
    subjectId: input.subject.id,
    formKey: input.formKey,
    params: input.params ?? {},
    requestedBy: input.requestedBy,
    target: input.withFile ? { fileId: newId(), versionId: newId() } : {},
    dedupeKey: input.dedupeKey ?? null,
  })
  await JobService.schedule(tx, ctx, {
    queue: RENDER_JOB.queue,
    name: RENDER_JOB.name,
    objectId: input.subject.id,
    idempotencyKey: `document.render:${id}`,
    data: { renderId: id },
    options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  })
  await publishEvent(tx, ctx, {
    type: 'document.render_queued',
    object: {
      id: input.subject.id,
      type: input.subject.type,
      spaceId: input.subject.spaceId,
      title: input.subject.title,
    },
    payload: { renderId: id, kind: input.kind, form: input.formKey },
  })
  return id
}
