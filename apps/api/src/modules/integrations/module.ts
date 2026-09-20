import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { queue } from '~/kernel/jobs/service.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerIntegrationConfigSections } from './domain/config-sections.js'
import { registerIntegrationObjectTypes } from './domain/object-types.js'
import {
  deliverOnce,
  dispatchEvent,
  pruneDeliveries,
  WEBHOOK_DELIVER_JOB,
} from './domain/webhook-delivery.js'
import { registerConfigPackageRoutes } from './http/config-routes.js'
import { registerIntegrationRoutes } from './http/integration-routes.js'
import { registerApiTokenRoutes } from './http/token-routes.js'
import { registerWebhookRoutes } from './http/webhook-routes.js'

const PRUNE_JOB = 'webhooks.prune-deliveries'

/**
 * Модуль «Интеграции» (P5-E02, P5-E06, ADR-0097): токены публичного API,
 * исходящие и входящие вебхуки, объект `integration`, пакет конфигурации.
 */
export function registerIntegrationsObjectTypes(): void {
  registerFeature({
    key: 'integrations',
    titleKey: 'admin.features.items.integrations.title',
    hintKey: 'admin.features.items.integrations.hint',
    tags: ['integrations'],
    objectTypes: ['integration', 'webhook'],
  })

  registerIntegrationObjectTypes()
  registerIntegrationConfigSections()
}

export function registerIntegrationsRoutes(route: RouteRegistrar): void {
  registerApiTokenRoutes(route)
  registerIntegrationRoutes(route)
  registerWebhookRoutes(route)
  registerConfigPackageRoutes(route)
}

/** Подписчик шины и доставщик вебхуков — только в роли worker. */
export function registerIntegrationsBackground(): void {
  registerSubscriber({
    name: 'webhooks-dispatch',
    types: ['*'],
    handle: (event) => dispatchEvent(event),
  })
  registerJobHandler({
    queue: WEBHOOK_DELIVER_JOB.queue,
    name: WEBHOOK_DELIVER_JOB.name,
    concurrency: 8,
    handle: async (job) => deliverOnce((job.data as { deliveryId: string }).deliveryId),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: PRUNE_JOB,
    handle: async () => ({ deleted: await pruneDeliveries() }),
  })
}

/** Журнал доставок чистится раз в сутки: записи старше 30 дней удаляются. */
export async function scheduleIntegrationsJobs(): Promise<void> {
  await queue('maintenance').add(
    PRUNE_JOB,
    {},
    { repeat: { pattern: '30 3 * * *' }, jobId: `cron:${PRUNE_JOB}` },
  )
}
