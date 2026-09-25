import { Readable } from 'node:stream'
import { AuditEntry, HealthReport } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { AUDIT_ACTIONS, audit, auditBatches, queryAudit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { outboxLag } from '~/kernel/events/dispatcher.js'
import { EngineJobs } from '~/kernel/jobs/engine.js'
import { JobService } from '~/kernel/jobs/service.js'
import { searchHealthy } from '~/kernel/search/index-service.js'
import { storageHealthy } from '~/kernel/storage/s3.js'
import { config } from '~/shared/config/env.js'
import { csvCell } from '~/shared/csv.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { redis } from '~/shared/redis/index.js'
import { observabilitySnapshot } from './domain/observability.js'
import { registerBackupRoutes } from './http/backup-routes.js'
import { registerBrandingRoutes } from './http/branding-routes.js'
import { registerFeatureRoutes } from './http/features-routes.js'

const startedAt = Date.now()

export function registerAdminRoutes(route: RouteRegistrar): void {
  registerFeatureRoutes(route)
  registerBrandingRoutes(route)
  registerBackupRoutes(route)

  route({
    method: 'GET',
    url: '/admin/audit',
    auth: { capability: 'admin.audit.read' },
    tags: ['admin'],
    summary: 'Журнал аудита',
    schema: {
      querystring: z.object({
        actorId: z.uuid().optional(),
        action: z.string().max(100).optional(),
        objectId: z.uuid().optional(),
        severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      response: {
        200: z.object({ items: z.array(AuditEntry), nextCursor: z.string().nullable() }),
      },
    },
    handler: async (request) => queryAudit(request.query),
  })

  route({
    method: 'GET',
    url: '/admin/audit/export.csv',
    auth: { capability: 'admin.audit.read' },
    tags: ['admin'],
    summary: 'Выгрузка журнала аудита в CSV',
    schema: {
      querystring: z.object({
        actorId: z.uuid().optional(),
        action: z.string().max(100).optional(),
        objectId: z.uuid().optional(),
        severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    },
    handler: async (request, reply) => {
      const query = request.query
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.auditExported,
        details: { filter: query },
        severity: 'notice',
      })
      const header = [
        'id',
        'occurred_at',
        'actor_id',
        'actor',
        'on_behalf_of',
        'action',
        'object_type',
        'object_id',
        'severity',
        'ip',
        'user_agent',
        'details',
      ]
      async function* lines() {
        // BOM: Excel открывает UTF-8 с кириллицей без мастера импорта
        yield `\uFEFF${header.join(',')}\r\n`
        for await (const rows of auditBatches(query)) {
          const people = await directory().refs([
            ...new Set(rows.map((r) => r.actorId).filter((v): v is string => Boolean(v))),
          ])
          for (const row of rows) {
            yield `${[
              String(row.id),
              row.occurredAt,
              row.actorId ?? '',
              row.actorId ? (people.get(row.actorId)?.displayName ?? '') : '',
              row.onBehalfOf ?? '',
              row.action,
              row.objectType ?? '',
              row.objectId ?? '',
              row.severity,
              row.ip ?? '',
              row.userAgent ?? '',
              JSON.stringify(row.details ?? {}),
            ]
              .map(csvCell)
              .join(',')}\r\n`
          }
        }
      }
      const stamp = new Date().toISOString().slice(0, 10)
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="kchs-audit-${stamp}.csv"`)
      return reply.send(Readable.from(lines()))
    },
  })

  route({
    method: 'GET',
    url: '/admin/health',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Здоровье системы',
    schema: { response: { 200: HealthReport } },
    handler: async () => {
      const components = await Promise.all([
        check('postgres', async () => {
          await db().execute(sql`select 1`)
        }),
        check('redis', async () => {
          await redis().ping()
        }),
        check('meilisearch', async () => {
          if (!(await searchHealthy())) throw new Error('недоступен')
        }),
        check('storage', async () => {
          if (!(await storageHealthy())) throw new Error('недоступно')
        }),
        // Движок — в установке всегда, при разработке — если поднят (ENGINE_INTERNAL_URL)
        ...(config().ENGINE_INTERNAL_URL
          ? [
              check('engine', async () => {
                const response = await fetch(`${config().ENGINE_INTERNAL_URL}/health`, {
                  signal: AbortSignal.timeout(3000),
                })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
              }),
            ]
          : []),
      ])

      const [lag, jobs, observed] = await Promise.all([
        outboxLag(),
        JobService.counts(),
        observabilitySnapshot(),
      ])
      const down = components.filter((c) => c.status === 'down').length

      return {
        status: down > 0 ? ('degraded' as const) : ('ok' as const),
        version: config().KCHS_VERSION ?? 'dev',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        components,
        outbox: lag,
        jobs,
        metrics: observed.metrics,
        alerts: observed.alerts,
      }
    },
  })

  route({
    method: 'POST',
    url: '/admin/engine/echo',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Проверка движка: задание уходит в очередь и возвращает результат',
    schema: {
      body: z.object({ message: z.string().max(200).default('ping') }),
      response: { 200: z.object({ jobId: z.uuid() }) },
    },
    handler: async (request) => ({
      jobId: await EngineJobs.echo(request.ctx, request.body.message),
    }),
  })

  route({
    method: 'GET',
    url: '/admin/jobs',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Активные задания',
    handler: async () => ({ items: await JobService.listActive() }),
  })
}

async function check(
  name: string,
  probe: () => Promise<void>,
): Promise<{
  name: string
  status: 'ok' | 'degraded' | 'down'
  detail: string | null
  latencyMs: number | null
}> {
  const started = Date.now()
  try {
    await probe()
    return { name, status: 'ok', detail: null, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      name,
      status: 'down',
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    }
  }
}

export { csvCell }
