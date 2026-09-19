import type { AccessReason, Capability, Level } from '@kchs/contracts'
import { type SQL, sql } from 'drizzle-orm'
import { hasCapability } from '~/kernel/access/authorize.js'
import type { TypePolicy } from '~/kernel/access/types.js'
import type { UserCtx } from '~/shared/context.js'

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
