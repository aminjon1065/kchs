import type { EventEnvelope } from '@kchs/contracts'
import { EVENT_PAYLOADS, eventDomain, isKnownEventType } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { outbox } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
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

/**
 * Тип события обязан быть в каталоге, а полезная нагрузка — соответствовать
 * его схеме (contracts/events.md): подписчики, вебхуки и движок опираются на неё.
 */
function checkedPayload(input: EventInput): Record<string, unknown> {
  if (!isKnownEventType(input.type)) {
    throw errors.internal(`Событие «${input.type}» не описано в каталоге событий`)
  }
  const parsed = EVENT_PAYLOADS[input.type].safeParse(input.payload ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw errors.internal(
      `Полезная нагрузка события «${input.type}» не соответствует схеме: ${issues}`,
    )
  }
  // Схема не срезает дополнительные поля: подписчики модулей могут на них опираться
  return { ...(input.payload ?? {}), ...(parsed.data as Record<string, unknown>) }
}

export function buildEnvelope(ctx: Ctx, input: EventInput): EventEnvelope {
  const payload = checkedPayload(input)
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
    payload,
    changedFields: input.changedFields ?? null,
    correlationId: input.correlationId ?? ctx.requestId,
    causationId: input.causationId ?? null,
    source: input.source ?? (ctx.kind === 'user' ? 'api' : 'worker'),
    visibility: input.visibilityPrincipals ? { principals: input.visibilityPrincipals } : null,
  }
}
