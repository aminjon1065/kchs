import { sql } from 'drizzle-orm'
import { hasCapability } from '~/kernel/access/authorize.js'
import type { TypePolicy } from '~/kernel/access/types.js'
import { registerObjectType } from '~/kernel/objects/registry.js'

/** Способность «интеграции и автоматизация» (03-access-model.md §Способности). */
export const MANAGE = 'automation.manage' as const

/**
 * Интеграции и вебхуки ведёт администратор интеграций. Обычный сотрудник их не
 * видит: в конфигурации адреса внутренних служб, а в журнале доставок — чужие
 * события. Права — только по способности и явной выдаче (ADR-0097).
 */
const adminPolicy: TypePolicy = {
  derive: async (ctx) =>
    hasCapability(ctx, MANAGE)
      ? [
          {
            level: 'manage' as const,
            reason: {
              kind: 'type_policy' as const,
              level: 'manage' as const,
              messageKey: 'access.reason.type_policy',
              params: { policy: 'Администратор интеграций' },
            },
          },
        ]
      : [],
  visibleSql: (ctx) => (hasCapability(ctx, MANAGE) ? sql`true` : null),
}

export function registerIntegrationObjectTypes(): void {
  registerObjectType({
    type: 'integration',
    labelKey: 'objects.types.integration',
    icon: 'integration',
    route: (id) => `/o/${id}`,
    levels: ['view', 'manage'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'manage', capability: MANAGE },
      check: { minLevel: 'view', capability: MANAGE },
      manage: { minLevel: 'manage', capability: MANAGE },
      share: { minLevel: 'manage', capability: MANAGE },
      delete: { minLevel: 'manage', capability: MANAGE },
    },
    policy: adminPolicy,
    discussable: false,
    linkable: false,
    hasParentTree: false,
    moduleManaged: true,
  })

  registerObjectType({
    type: 'webhook',
    labelKey: 'objects.types.webhook',
    icon: 'webhook',
    route: (id) => `/o/${id}`,
    levels: ['view', 'manage'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'manage', capability: MANAGE },
      manage: { minLevel: 'manage', capability: MANAGE },
      share: { minLevel: 'manage', capability: MANAGE },
      delete: { minLevel: 'manage', capability: MANAGE },
    },
    policy: adminPolicy,
    discussable: false,
    linkable: false,
    hasParentTree: false,
    moduleManaged: true,
  })
}
