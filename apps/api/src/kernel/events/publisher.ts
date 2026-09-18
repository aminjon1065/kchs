import type { EventEnvelope } from '@kchs/contracts'
import { eventDomain } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { outbox } from '~/shared/db/schema/index.js'
import { newEventId } from '~/shared/ids.js'
import type { EventInput } from './types.js'

/**
 * Записывает событие в outbox **в той же транзакции**, что и изменение данных
 * (02-platform-kernel.md §4). Это единственный способ публиковать события.
 */
export async function publishEvent(
  tx: Executor,
  ctx: Ctx,
  input: EventInput,
): Promise<EventEnvelope> {
  const envelope = buildEnvelope(ctx, input)
  await tx.insert(outbox).values({
    eventId: envelope.id,
    type: envelope.type,
    domain: eventDomain(envelope.type),
    event: envelope as unknown as Record<string, unknown>,
  })
  return envelope
}

export async function publishEvents(
  tx: Executor,
  ctx: Ctx,
  inputs: EventInput[],
): Promise<EventEnvelope[]> {
  if (inputs.length === 0) return []
  const envelopes = inputs.map((input) => buildEnvelope(ctx, input))
  await tx.insert(outbox).values(
    envelopes.map((envelope) => ({
      eventId: envelope.id,
      type: envelope.type,
      domain: eventDomain(envelope.type),
      event: envelope as unknown as Record<string, unknown>,
    })),
  )
  return envelopes
}

export function buildEnvelope(ctx: Ctx, input: EventInput): EventEnvelope {
  const isUser = ctx.kind === 'user'
  return {
    id: newEventId(),
    type: input.type,
    version: input.version ?? 1,
    occurredAt: new Date().toISOString(),
    actor: {
      kind: isUser ? 'user' : 'system',
      userId: isUser ? ctx.userId : ctx.initiatorId,
      onBehalfOf: isUser ? ctx.onBehalfOf : null,
      sessionId: isUser ? ctx.sessionId : null,
    },
    object: input.object
      ? {
          id: input.object.id,
          type: input.object.type,
          spaceId: input.object.spaceId ?? null,
          title: input.object.title ?? null,
        }
      : null,
    target: input.target
      ? {
          id: input.target.id,
          type: input.target.type,
          spaceId: input.target.spaceId ?? null,
          title: input.target.title ?? null,
        }
      : null,
    payload: input.payload ?? {},
    changedFields: input.changedFields ?? null,
    correlationId: input.correlationId ?? ctx.requestId,
    causationId: input.causationId ?? null,
    source: input.source ?? (ctx.kind === 'user' ? 'api' : 'worker'),
    visibility: input.visibilityPrincipals ? { principals: input.visibilityPrincipals } : null,
  }
}
