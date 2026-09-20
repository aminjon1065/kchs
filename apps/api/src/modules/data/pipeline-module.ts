import {
  PipelineCreateInput,
  PipelineList,
  PipelinePreviewInput,
  PipelineRecord,
  PipelineRunList,
  PipelineRunStarted,
  PipelineUpdateInput,
  PipelineValidateInput,
  PipelineValidateResult,
  QueryResult,
} from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { registerEntityScheduleProvider } from '~/kernel/schedules/index.js'
import { db } from '~/shared/db/client.js'
import { objects, pipelines } from '~/shared/db/schema/index.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { logger } from '~/shared/logger/index.js'
import {
  PIPELINE_SCHEDULE_JOB,
  pipelineScheduleProvider,
  syncPipelineSchedule,
  syncPipelineSchedules,
} from './domain/pipeline-schedules.js'
import { PIPELINE_JOB, type PipelineJobData, PipelineService } from './domain/pipeline-service.js'

const IdParam = z.object({ id: z.uuid() })
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) })

/**
 * Пайплайн преобразований — объект реестра `pipeline` (06-analytics-engine.md
 * §16, ADR-0106). Права на пайплайн не открывают данные: прогон читает входы с
 * политиками запустившего, а результат создаётся с ограниченным доступом.
 */
export function registerPipelineObjectType(): void {
  registerObjectType({
    type: 'pipeline',
    labelKey: 'objects.types.pipeline',
    icon: 'pipeline',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      run: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
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
          description: pipelines.description,
        })
        .from(pipelines)
        .innerJoin(objects, eq(objects.id, pipelines.id))
        .where(eq(pipelines.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'pipeline',
        spaceId: row.spaceId,
        title: row.title,
        body: row.description ?? '',
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
    lifecycle: {
      // Снятый с учёта пайплайн не должен остаться в планировщике
      onDelete: async (_tx, _ctx, object) => {
        await syncPipelineSchedule(object.id).catch(() => undefined)
      },
    },
  })
}

export function registerPipelineRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/pipelines',
    auth: 'session',
    tags: ['data'],
    summary: 'Пайплайны преобразований, видимые смотрящему',
    schema: { querystring: ListQuery, response: { 200: PipelineList } },
    handler: async (request) => ({
      items: await PipelineService.list(request.ctx, request.query.limit),
    }),
  })

  route({
    method: 'POST',
    url: '/pipelines',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать пайплайн преобразований',
    schema: { body: PipelineCreateInput, response: { 200: PipelineRecord } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await PipelineService.create(request.ctx, request.body)
      await syncPipelineSchedule(id)
      return PipelineService.get(request.ctx, id)
    },
  })

  route({
    method: 'POST',
    url: '/pipelines/validate',
    auth: 'session',
    readOnly: true,
    tags: ['data'],
    summary: 'Проверить определение пайплайна: поля результата или ошибка шага',
    schema: { body: PipelineValidateInput, response: { 200: PipelineValidateResult } },
    handler: async (request) => PipelineService.validate(request.ctx, request.body.definition),
  })

  route({
    method: 'POST',
    url: '/pipelines/preview',
    auth: 'session',
    readOnly: true,
    tags: ['data'],
    summary: 'Предпросмотр результата шага на выборке — с политиками смотрящего',
    schema: { body: PipelinePreviewInput, response: { 200: QueryResult } },
    handler: async (request) => PipelineService.preview(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/pipelines/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Пайплайн: определение, расписание, состояние последнего прогона',
    schema: { params: IdParam, response: { 200: PipelineRecord } },
    handler: async (request) => PipelineService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/pipelines/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить пайплайн: шаги, расписание, запуск по импорту',
    schema: { params: IdParam, body: PipelineUpdateInput, response: { 200: PipelineRecord } },
    handler: async (request) => {
      const record = await PipelineService.update(request.ctx, request.params.id, request.body)
      await syncPipelineSchedule(request.params.id)
      return record
    },
  })

  route({
    method: 'POST',
    url: '/pipelines/:id/run',
    auth: { action: 'run' },
    tags: ['data'],
    summary: 'Запустить пайплайн: результат заменит строки выходного датасета',
    schema: { params: IdParam, response: { 200: PipelineRunStarted } },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request) => PipelineService.run(request.ctx, request.params.id, 'manual'),
  })

  route({
    method: 'GET',
    url: '/pipelines/:id/runs',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Журнал прогонов пайплайна',
    schema: { params: IdParam, querystring: RunsQuery, response: { 200: PipelineRunList } },
    handler: async (request) => ({
      items: await PipelineService.runs(request.params.id, request.query.limit),
    }),
  })
}

/** Задания и подписки пайплайнов — в роли worker. */
export function registerPipelineBackground(): void {
  registerJobHandler({
    queue: PIPELINE_JOB.queue,
    name: PIPELINE_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => PipelineService.execute(job.data as PipelineJobData, helpers),
  })

  // Планировщик ставит служебное задание, которое запускает прогон от имени владельца
  registerJobHandler({
    queue: PIPELINE_SCHEDULE_JOB.queue,
    name: PIPELINE_SCHEDULE_JOB.name,
    concurrency: 1,
    handle: async (job) => {
      const pipelineId = String((job.data as { pipelineId?: unknown }).pipelineId ?? '')
      if (!pipelineId) return { skipped: true }
      const runId = await PipelineService.runAsOwner(pipelineId, 'schedule')
      return { runId }
    },
  })

  registerSubscriber({
    name: 'data-pipeline-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (!job?.objectId || job.queue !== PIPELINE_JOB.queue || job.name !== PIPELINE_JOB.name) {
        return
      }
      await PipelineService.markFailed(
        job.objectId,
        job.id,
        String(event.payload.error ?? 'Сбой задания'),
      )
    },
  })

  // Пайплайн по событию импорта входного датасета (06-analytics-engine.md §16)
  registerSubscriber({
    name: 'data-pipeline-on-import',
    types: ['dataset.imported'],
    handle: async (event) => {
      const datasetId = event.object?.id
      if (!datasetId) return
      for (const pipelineId of await PipelineService.onImport(datasetId)) {
        try {
          await PipelineService.runAsOwner(pipelineId, 'import')
        } catch (error) {
          logger().warn({ err: error, pipelineId }, 'пайплайн по импорту не запущен')
        }
      }
    },
  })
}

/** Планировщики пайплайнов при старте воркера и порт экрана «Расписания». */
export async function schedulePipelineJobs(): Promise<void> {
  registerEntityScheduleProvider(pipelineScheduleProvider)
  await syncPipelineSchedules()
}
