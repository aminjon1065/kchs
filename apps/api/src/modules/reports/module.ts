import {
  ReportCreateInput,
  ReportFormat,
  ReportFromNotebookInput,
  ReportPrintPayload,
  ReportRecord,
  ReportRenderResult,
  ReportRenderStart,
  ReportRunDownload,
  ReportRunInput,
  ReportRunList,
  ReportRunRecord,
  ReportSchedule,
  ReportScheduleInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerCollabType } from '~/kernel/collab/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerFeature } from '~/kernel/features/registry.js'
import { registerInboxActionHandler } from '~/kernel/inbox/actions.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { JobService } from '~/kernel/jobs/service.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { indexObject } from '~/kernel/search/index-service.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { ReportDelivery } from './domain/delivery.js'
import { ReportService } from './domain/report-service.js'
import { REPORT_RENDER_JOB, ReportRuns } from './domain/run-service.js'
import { REPORT_SCHEDULE_JOB, ReportSchedules } from './domain/schedule-service.js'
import { ReportToDocument } from './domain/to-document.js'

const IdParam = z.object({ id: z.uuid() })
const RunParam = z.object({ runId: z.uuid() })
const Ok = z.object({ ok: z.boolean() })

function assertService(token: string | string[] | undefined): void {
  if (!validServiceToken(token)) throw errors.unauthorized('Недействительный сервисный токен')
}

/**
 * Отчёты (06-analytics-engine.md §12, P2-E05 S03–S05, ADR-0078): тип объекта,
 * совместный документ шаблона, действие элемента Входящих «Ознакомлен».
 */
export function registerReportsObjectTypes(): void {
  registerFeature({
    key: 'reports',
    titleKey: 'admin.features.items.reports.title',
    hintKey: 'admin.features.items.reports.hint',
    tags: ['reports'],
    objectTypes: ['report'],
  })

  registerObjectType({
    type: 'report',
    labelKey: 'objects.types.report',
    icon: 'report',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      /** Правка шаблона: документ открывается не только для чтения. */
      edit: { minLevel: 'edit' },
      /** «Сформировать» — под своими правами: читатель получает свои данные. */
      render: { minLevel: 'view' },
      /** Расписание и получатели рассылки. */
      schedule: { minLevel: 'manage' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    searchable: (id) => ReportService.searchable(id),
  })

  registerCollabType({
    type: 'report',
    initialState: (id, executor) => ReportService.initialState(id, executor),
    snapshot: (tx, ctx, id, doc) => ReportService.snapshot(tx, ctx, id, doc),
  })

  // Отчёт по расписанию во Входящих: «Ознакомлен» закрывает элемент
  registerInboxActionHandler('report', async (ctx, { item, action }) => {
    if (action !== 'acknowledge' || !item.objectId) throw errors.validation('Нет такого действия')
    const objectId = item.objectId
    await db().transaction((tx) =>
      InboxService.resolve(tx, ctx, { objectId, kind: 'report', userId: item.userId }),
    )
  })
}

export function registerReportsRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/reports',
    auth: 'session',
    tags: ['reports'],
    summary: 'Создать отчёт',
    description: 'Блоки, параметры и настройки — начальный шаблон; дальше он правится совместно.',
    schema: { body: ReportCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => ReportService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    method: 'POST',
    url: '/reports/from-notebook',
    auth: 'session',
    tags: ['reports'],
    summary: 'Экспорт в отчёт: ячейки тетради → блоки нового отчёта',
    schema: { body: ReportFromNotebookInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => ({
      id: await ReportService.fromNotebook(request.ctx, request.body),
    }),
  })

  route({
    method: 'GET',
    url: '/reports/:id',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Отчёт: снимок шаблона, параметры и настройки печати',
    schema: { params: IdParam, response: { 200: ReportRecord } },
    handler: async (request) => ReportService.get(request.params.id),
  })

  route({
    method: 'POST',
    url: '/reports/:id/runs',
    auth: { action: 'render' },
    tags: ['reports'],
    summary: 'Сформировать отчёт (PDF/DOCX) под своими правами — задание движка',
    schema: { params: IdParam, body: ReportRunInput, response: { 200: ReportRunRecord } },
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async (request) =>
      ReportRuns.start(request.ctx, request.params.id, request.body ?? {}),
  })

  route({
    method: 'POST',
    url: '/reports/:id/document',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Отчёт исходящим документом: файл последнего прогона — первой версией',
    description:
      'Дальше документ идёт обычным маршрутом: согласование, подпись, регистрация, рассылка.',
    rateLimit: { max: 10, timeWindow: '1 minute' },
    schema: {
      params: IdParam,
      body: z.object({ typeId: z.uuid(), subject: z.string().trim().max(500).optional() }),
      response: { 200: z.object({ documentId: z.uuid() }) },
    },
    handler: async (request) =>
      ReportToDocument.create(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'GET',
    url: '/reports/:id/runs',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'История запусков: свои; управляющему отчётом — все',
    schema: { params: IdParam, response: { 200: ReportRunList } },
    handler: async (request) => ({ items: await ReportRuns.list(request.ctx, request.params.id) }),
  })

  route({
    method: 'GET',
    url: '/reports/runs/:runId',
    auth: 'session',
    tags: ['reports'],
    summary: 'Запуск отчёта: состояние, файлы, доставка',
    schema: { params: RunParam, response: { 200: ReportRunRecord } },
    handler: async (request) => ReportRuns.get(request.ctx, request.params.runId),
  })

  route({
    method: 'GET',
    url: '/reports/runs/:runId/download',
    auth: 'session',
    tags: ['reports'],
    summary: 'Ссылка на файл запуска — тому, под чьими правами он построен',
    schema: {
      params: RunParam,
      querystring: z.object({ format: ReportFormat.default('pdf') }),
      response: { 200: ReportRunDownload },
    },
    handler: async (request) =>
      ReportRuns.download(request.ctx, request.params.runId, request.query.format),
  })

  route({
    method: 'GET',
    url: '/reports/:id/schedule',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Расписание рассылки отчёта',
    schema: {
      params: IdParam,
      response: { 200: z.object({ schedule: ReportSchedule.nullable() }) },
    },
    handler: async (request) => ({ schedule: await ReportSchedules.get(request.params.id) }),
  })

  route({
    method: 'PUT',
    url: '/reports/:id/schedule',
    auth: { action: 'schedule' },
    tags: ['reports'],
    summary: 'Задать расписание и получателей рассылки',
    description:
      'Каждый получатель получает свой рендер под своими правами (ADR-0078); каналы — Входящие, почта, Telegram.',
    schema: { params: IdParam, body: ReportScheduleInput, response: { 200: ReportSchedule } },
    handler: async (request) => ReportSchedules.set(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'DELETE',
    url: '/reports/:id/schedule',
    auth: { action: 'schedule' },
    tags: ['reports'],
    summary: 'Снять рассылку отчёта',
    schema: { params: IdParam, response: { 200: Ok } },
    handler: async (request) => {
      await ReportSchedules.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/reports/:id/schedule/run',
    auth: { action: 'schedule' },
    tags: ['reports'],
    summary: 'Отправить сейчас: рассылка вне расписания',
    schema: {
      params: IdParam,
      response: { 200: z.object({ runs: z.number().int(), skipped: z.number().int() }) },
    },
    rateLimit: { max: 5, timeWindow: '1 minute' },
    handler: async (request) => ReportSchedules.runNow(request.params.id),
  })

  // ─── Страница печати (web /print/report/…) ─────────────────────────────────

  route({
    method: 'GET',
    url: '/print/report-runs/:runId',
    auth: 'session',
    tags: ['reports'],
    summary: 'Страница печати запуска: шаблон, параметры и пользователь, под кем строится отчёт',
    description:
      'Открывает браузер того, под чьими правами строится запуск, или Chromium движка со служебным токеном (cookie kchs_print).',
    schema: { params: RunParam, response: { 200: ReportPrintPayload } },
    handler: async (request) => ReportRuns.printPayload(request.ctx, request.params.runId),
  })

  route({
    method: 'GET',
    url: '/print/reports/:id',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Предпросмотр печати текущего шаблона — с правами смотрящего',
    schema: { params: IdParam, response: { 200: ReportPrintPayload } },
    handler: async (request) => ReportRuns.previewPayload(request.ctx, request.params.id),
  })

  // ─── Движок (сервисный токен, внутренняя сеть) ─────────────────────────────

  route({
    method: 'POST',
    url: '/internal/reports/runs/:runId/start',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок начинает рендер: служебный токен страницы печати (ADR-0078)',
    schema: {
      params: RunParam,
      response: { 200: ReportRenderStart },
    },
    handler: async (request) => {
      assertService(request.headers['x-kchs-service-token'])
      return ReportRuns.engineStart(request.params.runId)
    },
  })

  route({
    method: 'POST',
    url: '/internal/reports/runs/:runId/rendered',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок положил файлы отчёта в бакет экспортов',
    schema: { params: RunParam, body: ReportRenderResult, response: { 200: Ok } },
    handler: async (request) => {
      assertService(request.headers['x-kchs-service-token'])
      await ReportRuns.engineRendered(request.params.runId, request.body)
      return { ok: true }
    },
  })
}

/** Подписчики и задания отчётов — в роли worker. */
export function registerReportsBackground(): void {
  registerJobHandler({
    queue: REPORT_SCHEDULE_JOB.queue,
    name: REPORT_SCHEDULE_JOB.name,
    concurrency: 2,
    handle: async (job) => ReportSchedules.fire(String(job.data.reportId)),
  })

  registerSubscriber({
    name: 'reports-delivery',
    types: ['report.generated'],
    handle: async (event) => {
      await ReportDelivery.deliver(String(event.payload.runId))
    },
  })

  // Окончательный сбой задания рендера: запуск не должен навсегда остаться «идёт»
  registerSubscriber({
    name: 'reports-run-failed',
    types: ['job.failed'],
    handle: async (event) => {
      const job = await JobService.get(event.payload.jobId as string)
      if (job?.queue !== REPORT_RENDER_JOB.queue || job.name !== REPORT_RENDER_JOB.name) return
      const payload = await JobService.payload(job.id)
      const runId = typeof payload?.runId === 'string' ? payload.runId : null
      if (!runId) return
      const message = String(event.payload.error ?? 'Сбой рендера')
      await db().transaction((tx) => ReportRuns.fail(tx, runId, message, false))
    },
  })

  // Планировщик рассылки следует за расписанием и за жизнью отчёта
  registerSubscriber({
    name: 'reports-scheduler',
    types: [
      'report.schedule_changed',
      'object.trashed',
      'object.deleted',
      'object.restored',
      'object.archived',
    ],
    handle: async (event) => {
      if (event.object?.type === 'report') await ReportSchedules.sync(event.object.id)
    },
  })

  registerSubscriber({
    name: 'reports-search',
    types: ['report.updated'],
    handle: async (event) => {
      if (event.object) await indexObject(event.object.id)
    },
  })
}

/** Планировщики рассылок — при старте воркера (идемпотентно). */
export async function scheduleReportsJobs(): Promise<void> {
  await ReportSchedules.syncAll()
}
