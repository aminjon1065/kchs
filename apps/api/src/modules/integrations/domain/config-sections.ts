import type { ConfigItem, IntegrationKind, WebhookCreateInput } from '@kchs/contracts'
import { registerConfigSection } from '~/kernel/config-package/registry.js'
import type { UserCtx } from '~/shared/context.js'
import { Integrations, readSecrets } from './integration-service.js'
import { MANAGE } from './object-types.js'
import { Webhooks } from './webhook-service.js'

/**
 * Интеграции и вебхуки в пакете конфигурации (ADR-0097).
 *
 * Секреты в пакет не попадают: переносится настройка, а не учётные данные
 * чужого контура (17-security.md §1). Вместо значений едет список имён —
 * после импорта администратор вводит свои.
 */
function integrationItem(row: {
  key: string
  kind: string
  description: string | null
  enabled: boolean
  config: Record<string, unknown>
  inboundEnabled: boolean
  updatedAt: string
  secrets: Buffer | null
  title: string
}): ConfigItem {
  return {
    section: 'integrations',
    key: row.key,
    title: row.title,
    updatedAt: row.updatedAt,
    data: {
      name: row.title,
      kind: row.kind,
      description: row.description,
      enabled: row.enabled,
      config: row.config,
      inboundEnabled: row.inboundEnabled,
      requiredSecrets: Object.keys(readSecrets({ secrets: row.secrets })).sort(),
    },
  }
}

export function registerIntegrationConfigSections(): void {
  registerConfigSection({
    section: 'integrations',
    capability: MANAGE,
    list: async () => {
      const items: ConfigItem[] = []
      for (const integration of await Integrations.list()) {
        // Встроенные службы настраиваются окружением — переносить нечего
        if (integration.source === 'env') continue
        const found = await Integrations.byKey(integration.key)
        if (found) items.push(integrationItem({ ...found.row, title: found.title }))
      }
      return items
    },
    find: async (key) => {
      const found = await Integrations.byKey(key)
      return found ? integrationItem({ ...found.row, title: found.title }) : null
    },
    apply: async (ctx: UserCtx, item) => {
      const data = item.data as {
        name?: string
        kind?: string
        description?: string | null
        enabled?: boolean
        config?: Record<string, unknown>
        inboundEnabled?: boolean
      }
      const existing = await Integrations.byKey(item.key)
      if (existing) {
        await Integrations.update(ctx, existing.row.id, {
          name: data.name ?? item.title,
          description: data.description ?? null,
          enabled: data.enabled ?? true,
          config: data.config ?? {},
          inboundEnabled: data.inboundEnabled ?? false,
        })
        return 'updated'
      }
      await Integrations.create(ctx, {
        key: item.key,
        kind: (data.kind ?? 'custom') as IntegrationKind,
        name: data.name ?? item.title,
        description: data.description ?? null,
        // Интеграция приезжает выключенной: секретов в пакете нет
        enabled: false,
        config: data.config ?? {},
        secrets: {},
        inboundEnabled: false,
      })
      return 'created'
    },
  })

  registerConfigSection({
    section: 'webhooks',
    capability: MANAGE,
    list: async () => {
      const items: ConfigItem[] = []
      for (const hook of await Webhooks.list()) {
        items.push({
          section: 'webhooks',
          key: hook.key,
          title: hook.name,
          updatedAt: hook.updatedAt,
          data: {
            name: hook.name,
            url: hook.url,
            eventTypes: hook.eventTypes,
            disableAfterFailures: hook.disableAfterFailures,
          },
        })
      }
      return items
    },
    find: async (key) => {
      const found = await Webhooks.byKey(key)
      if (!found) return null
      return {
        section: 'webhooks',
        key: found.row.key,
        title: found.title,
        updatedAt: found.row.updatedAt,
        data: {
          name: found.title,
          url: found.row.url,
          eventTypes: found.row.eventTypes,
          disableAfterFailures: found.row.disableAfterFailures,
        },
      }
    },
    apply: async (ctx: UserCtx, item) => {
      const data = item.data as Partial<WebhookCreateInput>
      const existing = await Webhooks.byKey(item.key)
      if (existing) {
        await Webhooks.update(ctx, existing.row.id, {
          name: data.name ?? item.title,
          url: data.url ?? existing.row.url,
          eventTypes: data.eventTypes ?? existing.row.eventTypes,
          disableAfterFailures: data.disableAfterFailures ?? existing.row.disableAfterFailures,
        })
        return 'updated'
      }
      // Новый вебхук приезжает на паузе: секрет подписи выпускается здесь,
      // получателю его ещё предстоит сообщить
      await Webhooks.create(
        ctx,
        {
          name: data.name ?? item.title,
          url: data.url ?? '',
          eventTypes: data.eventTypes ?? ['object.*'],
          spaceIds: [],
          status: 'paused',
          disableAfterFailures: data.disableAfterFailures ?? 20,
        },
        item.key,
      )
      return 'created'
    },
  })
}
