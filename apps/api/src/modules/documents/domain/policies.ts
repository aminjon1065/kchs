import {
  type AccessReason,
  type Capability,
  type Level,
  levelFromValue,
  maxLevel,
} from '@kchs/contracts'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { hasCapability } from '~/kernel/access/authorize.js'
import type { TypePolicy } from '~/kernel/access/types.js'
import { delegationCovers } from '~/kernel/inbox/service.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { documentParticipants, objects } from '~/shared/db/schema/index.js'

function reason(level: Level, policy: string): AccessReason {
  return {
    kind: 'type_policy',
    level,
    messageKey: 'access.reason.type_policy',
    params: { policy },
    sourceObjectId: null,
  }
}

/**
 * Политика справочника документооборота (03-access-model.md §5): владельцу
 * способности — производный уровень на все объекты типа. Способность не
 * наследуется вниз по дереву: права журнала на его документы дают только записи
 * ACL журнала (делопроизводители), а не способность «вести журналы».
 */
export function capabilityPolicy(
  capabilities: Capability[],
  level: Level,
  policy: string,
): TypePolicy {
  const holds = (ctx: UserCtx) => capabilities.some((capability) => hasCapability(ctx, capability))
  return {
    derive: async (ctx) => (holds(ctx) ? [{ level, reason: reason(level, policy) }] : []),
    visibleSql: (ctx): SQL | null => (holds(ctx) ? sql`true` : null),
  }
}

/**
 * Замещаемый в делах документов: режим «от имени» в пределах замещения с
 * областью документов (`all`, `documents`).
 */
function actingDocumentsFor(ctx: UserCtx): string | null {
  const target = ctx.onBehalfOf
  if (!target) return null
  const active = ctx.principals.actingFor.some(
    (item) => item.userId === target && delegationCovers('resolve', item.scope),
  )
  return active ? target : null
}

/**
 * Политика типа `document` (ADR-0084): заместитель в режиме «от имени» видит
 * и обсуждает документ на уровне участия замещаемого (карточка, резолюции,
 * направления, ознакомление) — так дела Входящих, скопированные заместителю,
 * открываются и исполняются. Гриф проверяется ядром до политик: заместитель
 * без допуска документ не увидит.
 */
export const documentPolicy: TypePolicy = {
  derive: async (ctx, object) => {
    const acting = actingDocumentsFor(ctx)
    if (!acting) return []
    const rows = await db()
      .select({ level: documentParticipants.level })
      .from(documentParticipants)
      .where(
        and(
          eq(documentParticipants.documentId, object.id),
          eq(documentParticipants.userId, acting),
        ),
      )
    if (rows.length === 0) return []
    const level = rows.reduce<Level>(
      (current, row) => maxLevel(current, levelFromValue(row.level)),
      'none',
    )
    return [
      {
        level,
        reason: {
          kind: 'type_policy',
          level,
          messageKey: 'access.reason.acting_document_participant',
          params: {},
          sourceObjectId: null,
        },
      },
    ]
  },
  visibleSql: (ctx): SQL | null => {
    const acting = actingDocumentsFor(ctx)
    if (!acting) return null
    return sql`${objects.id} IN (SELECT ${documentParticipants.documentId} FROM ${documentParticipants}
      WHERE ${documentParticipants.userId} = ${acting})`
  },
}
