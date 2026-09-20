import { PAGE_STATUSES } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { registerCollabType } from '~/kernel/collab/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { queue } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { ensurePageChunkIndex } from './domain/page-chunks.js'
import { registerPagePrintForm } from './domain/page-print.js'
import { reviewDuePages } from './domain/page-review.js'
import { PageService } from './domain/page-service.js'
import { pageSubscribers } from './domain/page-subscribers.js'

export { registerKnowledgeRoutes } from './http/routes.js'

/**
 * Тип `page` (13-search-knowledge-ai.md §2, ADR-0095) — при старте в любой
 * роли: HTTP проверяет права, воркер — подписчиков. Страница живёт в дереве
 * пространства, правится совместно (уровень `edit`), а публикация, срок
 * пересмотра и ознакомление — за тем, кто ею распоряжается (`manage`).
 */
export function registerKnowledgeObjectTypes(): void {
  registerObjectType({
    type: 'page',
    labelKey: 'objects.types.page',
    icon: 'book-open',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      /** Обсуждение страницы и комментарии к её фрагментам. */
      comment: { minLevel: 'comment' },
      edit: { minLevel: 'edit' },
      /** Вложенная страница — тому, кто правит родительскую. */
      create_child: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      request_acknowledgment: { minLevel: 'manage', allowArchived: true },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    searchable: (id) => PageService.searchable(id),
    listFields: [
      {
        key: 'status',
        labelKey: 'knowledge.fields.status',
        type: 'select',
        sql: sql`${objects.meta}->>'status'`,
        sortable: true,
        options: PAGE_STATUSES.map((value) => ({
          value,
          labelKey: `knowledge.status.${value}`,
        })),
      },
    ],
    summary: async (ids) => {
      const rows = await PageService.summaries(ids)
      return new Map([...rows].map(([id, meta]) => [id, { meta }]))
    },
  })

  registerCollabType({
    type: 'page',
    initialState: (id, executor) => PageService.initialState(id, executor),
    snapshot: (tx, ctx, id, doc) => PageService.snapshot(tx, ctx, id, doc),
  })

  // Печать страницы — реестром печатных форм (ADR-0085)
  registerPagePrintForm()
}

/** Подписчики и задание пересмотра — только в роли worker. */
export function registerKnowledgeBackground(): void {
  for (const subscriber of pageSubscribers) registerSubscriber(subscriber)
  registerJobHandler({
    queue: 'maintenance',
    name: 'knowledge.review',
    concurrency: 1,
    handle: async () => {
      const opened = await reviewDuePages()
      return { opened }
    },
  })
}

/**
 * Индекс чанков и расписание пересмотра: индекс — как у сообщений (ADR-0090),
 * его недоступность не мешает старту; проход по срокам — раз в сутки утром.
 */
export async function scheduleKnowledgeJobs(): Promise<void> {
  try {
    await ensurePageChunkIndex()
  } catch (error) {
    logger().warn({ err: error, module: 'knowledge' }, 'индекс чанков страниц не готов')
  }
  await queue('maintenance').add(
    'knowledge.review',
    {},
    { repeat: { pattern: '10 9 * * *' }, jobId: 'cron:knowledge.review' },
  )
}
