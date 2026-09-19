import { AnalysisCreateInput, AnalysisRecord, AnalysisRunStarted } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ANALYSIS_JOB, type AnalysisJobData, AnalysisService } from './domain/analysis-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Пространственный анализ (07-gis-engine.md §10, ADR-0069): объект реестра
 * `analysis`. Права на анализ не открывают данные — запуск читает источники
 * с политиками запустившего; `run` — перезапуск с правом правки.
 */
export function registerAnalysisObjectType(): void {
  registerObjectType({
    type: 'analysis',
    labelKey: 'objects.types.analysis',
    icon: 'analysis',
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
        })
        .from(objects)
        .where(eq(objects.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: row.parentId,
        type: 'analysis',
        spaceId: row.spaceId,
        title: row.title,
        body: '',
        ownerId: row.ownerId,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: {},
      }
    },
  })
}

export function registerAnalysisRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/analyses',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать пространственный анализ (и запустить)',
    schema: { body: AnalysisCreateInput, response: { 200: AnalysisRecord } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await AnalysisService.create(request.ctx, request.body)
      return AnalysisService.get(id)
    },
  })

  route({
    method: 'GET',
    url: '/analyses/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Анализ: параметры, источники, результат и состояние запуска',
    schema: { params: IdParam, response: { 200: AnalysisRecord } },
    handler: async (request) => AnalysisService.get(request.params.id),
  })

  route({
    method: 'POST',
    url: '/analyses/:id/run',
    auth: { action: 'run' },
    tags: ['data'],
    summary: 'Перезапустить анализ: результат заменит строки прежнего датасета',
    schema: { params: IdParam, response: { 200: AnalysisRunStarted } },
    handler: async (request) => AnalysisService.run(request.ctx, request.params.id),
  })
}

/** Задание анализа и окончательный сбой задания — в роли worker. */
export function registerAnalysisBackground(): void {
  registerJobHandler({
    queue: ANALYSIS_JOB.queue,
    name: ANALYSIS_JOB.name,
    concurrency: 2,
    handle: async (job, helpers) => AnalysisService.execute(job.data as AnalysisJobData, helpers),
  })

  registerSubscriber({
    name: 'data-analysis-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (!job?.objectId || job.queue !== ANALYSIS_JOB.queue || job.name !== ANALYSIS_JOB.name) {
        return
      }
      await AnalysisService.markFailed(
        job.objectId,
        job.id,
        String(event.payload.error ?? 'Сбой задания'),
      )
    },
  })
}
