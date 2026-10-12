import { registerAuditActions } from '~/kernel/audit/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { queue } from '~/kernel/jobs/service.js'
import { declareSchedule } from '~/kernel/schedules/index.js'
import { setQualifiedSignatureProvider } from '~/kernel/signature/port.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { INTEGRATIONS_AUDIT } from './domain/audit-actions.js'
import { registerIntegrationConfigSections } from './domain/config-sections.js'
import { CONNECTIONS_SYSTEM_DATASET } from './domain/connections-dataset.js'
import { EDMS_DISPATCH_JOB, EdmsSends } from './domain/edms.js'
import { Integrations } from './domain/integration-service.js'
import { registerIntegrationObjectTypes } from './domain/object-types.js'
import { flushTokenUsage, pruneUsage, recordUsageEvent, USAGE_EVENT_TYPES } from './domain/usage.js'
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
const USAGE_FLUSH_JOB = 'integrations.usage-flush'

/**
 * Модуль «Интеграции» (P5-E02, P5-E06, ADR-0097): токены публичного API,
 * исходящие и входящие вебхуки, объект `integration`, пакет конфигурации.
 */
export function registerIntegrationsObjectTypes(): void {
  registerAuditActions('integrations', INTEGRATIONS_AUDIT)
  registerFeature({
    key: 'integrations',
    titleKey: 'admin.features.items.integrations.title',
    hintKey: 'admin.features.items.integrations.hint',
    tags: ['integrations'],
    objectTypes: ['integration', 'webhook'],
  })

  registerIntegrationObjectTypes()
  registerIntegrationConfigSections()
  // Подключения шлюза по суткам (ADR-0206) — источник показателей дашборда «Интеграции»
  registerSystemDataset(CONNECTIONS_SYSTEM_DATASET)
  // Порт квалифицированной подписи ядра (ADR-0205): УЦ — интеграция `qes_ca`
  setQualifiedSignatureProvider({ authority: () => Integrations.qualifiedAuthority() })
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
  // Учёт подключений (ADR-0206): передачи из событий — сразу в суточные счётчики
  registerSubscriber({
    name: 'integrations-usage',
    types: USAGE_EVENT_TYPES,
    handle: (event) => recordUsageEvent(event),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: PRUNE_JOB,
    handle: async () => ({ deleted: await pruneDeliveries(), usage: await pruneUsage() }),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: USAGE_FLUSH_JOB,
    handle: async () => ({ flushed: await flushTokenUsage() }),
  })
  // Очередь отправок в ЭДО (ADR-0206): расписание объявляет адаптер, когда он появится
  registerJobHandler({
    queue: EDMS_DISPATCH_JOB.queue,
    name: EDMS_DISPATCH_JOB.name,
    handle: async () => EdmsSends.processDue(),
  })
}

/**
 * Журнал доставок чистится раз в сутки: записи старше 30 дней удаляются. Через
 * единый планировщик (ADR-0096) — задание видно и выключается на экране «Расписания».
 */
export function declareIntegrationsSchedules(): void {
  declareSchedule({
    queue: 'maintenance',
    name: PRUNE_JOB,
    pattern: '30 3 * * *',
    labelKey: 'schedules.jobs.webhooksPrune',
  })
  // Запросы токенов копятся в Redis и раз в минуту сбрасываются в суточные счётчики
  declareSchedule({
    queue: 'maintenance',
    name: USAGE_FLUSH_JOB,
    pattern: '* * * * *',
    labelKey: 'schedules.jobs.integrationsUsageFlush',
  })
}

export async function scheduleIntegrationsJobs(): Promise<void> {
  // Прежняя повторяемая запись (до ADR-0171) снимается — иначе очистка шла бы дважды
  await queue('maintenance').removeRepeatable(
    PRUNE_JOB,
    { pattern: '30 3 * * *' },
    `cron:${PRUNE_JOB}`,
  )
}
