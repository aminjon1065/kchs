import { AuditEntry, HealthReport } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { queryAudit } from '~/kernel/audit/service.js'
import { outboxLag } from '~/kernel/events/dispatcher.js'
import { EngineJobs } from '~/kernel/jobs/engine.js'
import { JobService } from '~/kernel/jobs/service.js'
import { searchHealthy } from '~/kernel/search/index-service.js'
import { storageHealthy } from '~/kernel/storage/s3.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { redis } from '~/shared/redis/index.js'

const startedAt = Date.now()

export function registerAdminRoutes(route: RouteRegistrar): void {
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
      ])

      const [lag, jobs] = await Promise.all([outboxLag(), JobService.counts()])
      const down = components.filter((c) => c.status === 'down').length

      return {
        status: down > 0 ? ('degraded' as const) : ('ok' as const),
        version: '0.1.0',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        components,
        outbox: lag,
        jobs,
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
