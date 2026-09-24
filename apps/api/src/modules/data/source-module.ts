import {
  FeedPreview,
  FeedPreviewInput,
  FeedSourceCreateInput,
  IntegrationCheckResult,
  SourceCreateInput,
  SourceList,
  SourcePreview,
  SourcePreviewInput,
  SourceRecord,
  SourceRunList,
  SourceRunStarted,
  SourceTableList,
  SourceUpdateInput,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerEntityScheduleProvider } from '~/kernel/schedules/index.js'
import { ExternalDatabase } from '~/modules/integrations/public.js'
import { db } from '~/shared/db/client.js'
import { objects, sources } from '~/shared/db/schema/index.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FeedService } from './domain/feed-service.js'
import {
  SOURCE_SCHEDULE_JOB,
  sourceScheduleProvider,
  syncSourceSchedule,
  syncSourceSchedules,
} from './domain/source-schedules.js'
import { SOURCE_SYNC_JOB, type SourceJobData, SourceService } from './domain/source-service.js'

const IdParam = z.object({ id: z.uuid() })
const IntegrationParam = z.object({ integrationId: z.uuid() })
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) })

/** Ведение подключений к внешним базам — способность администратора данных. */
const MANAGE = 'data.sources.manage'

/**
 * Источник датасета — объект реестра `source` (05-data-model.md §Данные,
 * ADR-0107). Ведение источников требует способности `data.sources.manage`:
 * настройка чтения чужой базы — не работа рядового аналитика.
 */
export function registerSourceObjectType(): void {
  registerObjectType({
    type: 'source',
    labelKey: 'objects.types.source',
    icon: 'source',
    route: (id) => `/o/${id}`,
    levels: ['view', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      edit: { minLevel: 'edit', capability: MANAGE },
      sync: { minLevel: 'edit', capability: MANAGE },
      manage: { minLevel: 'manage', capability: MANAGE },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage', capability: MANAGE },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          spaceId: objects.spaceId,
          parentId: objects.parentId,
          ownerId: objects.ownerId,
          updatedAt: objects.updatedAt,
          description: sources.description,
        })
        .from(sources)
        .innerJoin(objects, eq(objects.id, sources.id))
        .where(eq(sources.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'source',
        spaceId: row.spaceId,
        title: row.title,
        body: row.description ?? '',
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
    lifecycle: {
      onDelete: async (_tx, _ctx, object) => {
        await syncSourceSchedule(object.id).catch(() => undefined)
      },
    },
  })
}

export function registerSourceRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/sources',
    auth: 'session',
    tags: ['data'],
    summary: 'Источники датасетов из внешних баз',
    schema: { querystring: ListQuery, response: { 200: SourceList } },
    handler: async (request) => ({
      items: await SourceService.list(request.ctx, request.query.limit),
    }),
  })

  route({
    method: 'POST',
    url: '/sources',
    auth: { capability: MANAGE },
    tags: ['data'],
    summary: 'Завести источник: подключение, выборка и датасет-приёмник',
    schema: { body: SourceCreateInput, response: { 200: SourceRecord } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await SourceService.create(request.ctx, request.body)
      await syncSourceSchedule(id)
      return SourceService.get(request.ctx, id)
    },
  })

  route({
    method: 'POST',
    url: '/sources/feeds',
    auth: { capability: MANAGE },
    tags: ['data'],
    summary: 'Завести ленту по адресу: разбор, датасет-приёмник и расписание',
    schema: { body: FeedSourceCreateInput, response: { 200: SourceRecord } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await FeedService.create(request.ctx, request.body)
      await syncSourceSchedule(id)
      return SourceService.get(request.ctx, id)
    },
  })

  route({
    method: 'POST',
    url: '/sources/feed/preview',
    auth: { capability: MANAGE },
    readOnly: true,
    tags: ['data'],
    summary: 'Предпросмотр ленты по адресу: первые записи и найденные поля',
    schema: { body: FeedPreviewInput, response: { 200: FeedPreview } },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => FeedService.preview(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/sources/integrations/:integrationId/tables',
    auth: { capability: MANAGE },
    tags: ['data'],
    summary: 'Таблицы и представления внешней базы',
    schema: { params: IntegrationParam, response: { 200: SourceTableList } },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.params.integrationId)
      return { items: await ExternalDatabase.tables(request.params.integrationId) }
    },
  })

  route({
    method: 'POST',
    url: '/sources/preview',
    auth: { capability: MANAGE },
    readOnly: true,
    tags: ['data'],
    summary: 'Предпросмотр внешней выборки: столбцы с типами и первые строки',
    schema: { body: SourcePreviewInput, response: { 200: SourcePreview } },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.body.integrationId)
      return ExternalDatabase.preview(
        request.body.integrationId,
        request.body.query,
        request.body.limit,
      )
    },
  })

  route({
    method: 'GET',
    url: '/sources/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Источник: подключение, выборка, режим, расписание и состояние',
    schema: { params: IdParam, response: { 200: SourceRecord } },
    handler: async (request) => SourceService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/sources/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить источник: выборку, столбцы, режим, расписание',
    schema: { params: IdParam, body: SourceUpdateInput, response: { 200: SourceRecord } },
    handler: async (request) => {
      const record = await SourceService.update(request.ctx, request.params.id, request.body)
      await syncSourceSchedule(request.params.id)
      return record
    },
  })

  route({
    method: 'POST',
    url: '/sources/:id/check',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Проверить соединение и выборку источника',
    schema: { params: IdParam, response: { 200: IntegrationCheckResult } },
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) => {
      const result = await SourceService.check(request.ctx, request.params.id)
      return { ...result, checkedAt: new Date().toISOString() }
    },
  })

  route({
    method: 'POST',
    url: '/sources/:id/sync',
    auth: { action: 'sync' },
    tags: ['data'],
    summary: 'Синхронизировать сейчас: снимок или добор по курсору',
    schema: { params: IdParam, response: { 200: SourceRunStarted } },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => SourceService.run(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/sources/:id/runs',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Журнал синхронизаций источника',
    schema: { params: IdParam, querystring: RunsQuery, response: { 200: SourceRunList } },
    handler: async (request) => ({
      items: await SourceService.runs(request.params.id, request.query.limit),
    }),
  })
}

export function registerSourceBackground(): void {
  registerJobHandler({
    queue: SOURCE_SYNC_JOB.queue,
    name: SOURCE_SYNC_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => SourceService.execute(job.data as SourceJobData, helpers),
  })

  registerJobHandler({
    queue: SOURCE_SCHEDULE_JOB.queue,
    name: SOURCE_SCHEDULE_JOB.name,
    concurrency: 1,
    handle: async (job) => {
      const sourceId = String((job.data as { sourceId?: unknown }).sourceId ?? '')
      if (!sourceId) return { skipped: true }
      const runId = await SourceService.runAsOwner(sourceId)
      return { runId }
    },
  })

  registerSubscriber({
    name: 'data-source-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (
        !job?.objectId ||
        job.queue !== SOURCE_SYNC_JOB.queue ||
        job.name !== SOURCE_SYNC_JOB.name
      ) {
        return
      }
      await SourceService.markFailed(
        job.objectId,
        job.id,
        String(event.payload.error ?? 'Сбой задания'),
      )
    },
  })
}

export async function scheduleSourceJobs(): Promise<void> {
  registerEntityScheduleProvider(sourceScheduleProvider)
  await syncSourceSchedules()
}
