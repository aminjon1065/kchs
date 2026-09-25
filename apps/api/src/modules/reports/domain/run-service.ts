import {
  type Locale,
  REPORT_CONTENT_TYPES,
  REPORT_FORMATS,
  type ReportDeliveryChannel,
  type ReportDeliveryStatus,
  type ReportFormat,
  ReportParams,
  type ReportPrintPayload,
  type ReportRenderResult,
  type ReportRenderStart,
  type ReportRunInput,
  type ReportRunRecord,
  type ReportRunStatus,
  type ReportRunTrigger,
  type UserRef,
} from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { PrintGrants } from '~/kernel/print/grants.js'
import { buckets, headObject, signedGetUrl } from '~/kernel/storage/s3.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, reportRuns, users } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { ReportVersions } from './report-library.js'
import { ReportService } from './report-service.js'

/** Рендер — очередь `render` движка (ADR-0035): Chromium и docxtpl живут там. */
export const REPORT_RENDER_JOB = { queue: 'render', name: 'report.render' } as const

/** Незаконченный запуск старше этого считается зависшим и не держит новый. */
const STALE_RUN_MS = 30 * 60_000
/** Запусков в истории отчёта — последние. */
const HISTORY_LIMIT = 50

type RunRow = typeof reportRuns.$inferSelect

/** Файл запуска в бакете экспортов. */
export interface StoredRunFile {
  format: ReportFormat
  key: string
  fileName: string
  size: number
}

const ACTIVE: ReportRunStatus[] = ['queued', 'running']
const scopeOf = (runId: string) => `report-run:${runId}`

function filesOf(row: Pick<RunRow, 'files'>): StoredRunFile[] {
  return (row.files as StoredRunFile[]).filter(
    (file) => typeof file?.key === 'string' && REPORT_FORMATS.includes(file.format),
  )
}

function formatsOf(row: Pick<RunRow, 'formats'>): ReportFormat[] {
  return row.formats.filter((format): format is ReportFormat =>
    (REPORT_FORMATS as readonly string[]).includes(format),
  )
}

/** Дата ГГГГ-ММ-ДД в поясе пользователя — для имени файла. */
function isoDateIn(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** Имя файла для скачивания: название отчёта и дата, без символов, запрещённых в именах. */
export function reportFileName(title: string, date: string, format: ReportFormat): string {
  const base = title
    .replace(/[\\/?%*:|"<>]/g, ' ')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${base || 'report'} ${date}.${format}`
}

const placeholder = (id: string): UserRef => ({
  id,
  displayName: '—',
  avatarUrl: null,
  position: null,
  unitName: null,
})

async function toRecords(rows: RunRow[], viewerId: string | null): Promise<ReportRunRecord[]> {
  const refs = await directory().refs([...new Set(rows.map((row) => row.runAs))])
  return rows.map((row) => ({
    id: row.id,
    reportId: row.reportId,
    trigger: row.trigger as ReportRunTrigger,
    runAs: refs.get(row.runAs) ?? placeholder(row.runAs),
    status: row.status as ReportRunStatus,
    params: ReportParams.safeParse(row.params).data ?? { period: null, territory: null },
    formats: formatsOf(row),
    files: filesOf(row).map(({ format, fileName, size }) => ({ format, fileName, size })),
    pages: row.pages,
    durationMs: row.durationMs,
    error: row.error,
    delivery: row.delivery as Partial<Record<ReportDeliveryChannel, ReportDeliveryStatus>>,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    canDownload: row.status === 'succeeded' && viewerId === row.runAs,
  }))
}

async function loadRun(runId: string, executor: Executor = db()): Promise<RunRow | null> {
  const [row] = await executor.select().from(reportRuns).where(eq(reportRuns.id, runId)).limit(1)
  return row ?? null
}

async function reportObject(tx: Executor, reportId: string) {
  const [object] = await tx
    .select({ id: objects.id, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, reportId))
    .limit(1)
  if (!object) throw errors.notFound('Отчёт')
  return { id: object.id, type: 'report' as const, spaceId: object.spaceId, title: object.title }
}

/** Пользователь, под чьими правами строится отчёт: активный, с правом `view` на отчёт. */
async function runAsCtx(userId: string, reportId: string): Promise<UserCtx | null> {
  const [user] = await db()
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (user?.status !== 'active') return null
  const ctx = await buildUserCtxFor(userId)
  if (!ctx) return null
  const decision = await authorize(ctx, 'view', reportId, { soft: true })
  return decision.allowed ? ctx : null
}

export interface EnqueueRunInput {
  reportId: string
  runAs: string
  requestedBy: string | null
  trigger: ReportRunTrigger
  params: ReportParams
  formats: ReportFormat[]
  channels: ReportDeliveryChannel[]
  /** Внешние адреса рассылки: письмо им, а не `runAs` (ADR-0164). */
  externalEmails?: string[]
}

/**
 * Запуски рендера отчёта (P2-E05 S04–S05, ADR-0078). Запуск строится под правами
 * одного пользователя (`run_as`): «Сформировать» — под правами нажавшего,
 * расписание — под правами каждого получателя. Движок открывает страницу печати
 * веба со служебным токеном этого пользователя; файлы — в бакете экспортов,
 * скачать их может только он.
 */
export const ReportRuns = {
  /** Запуск в той же транзакции: запись, задание движка, событие. */
  async enqueue(tx: Executor, ctx: Ctx, input: EnqueueRunInput): Promise<string> {
    const id = newId()
    await tx.insert(reportRuns).values({
      id,
      reportId: input.reportId,
      trigger: input.trigger,
      runAs: input.runAs,
      requestedBy: input.requestedBy,
      params: input.params as unknown as Record<string, unknown>,
      formats: input.formats,
      channels: input.channels,
      externalEmails: input.externalEmails ?? [],
      status: 'queued',
    })
    const jobId = await JobService.schedule(tx, ctx, {
      ...REPORT_RENDER_JOB,
      objectId: input.reportId,
      data: { runId: id },
      // Повтор — один: сбой страницы обычно не проходит сам, а бюджет рендера — минута
      options: { attempts: 2, backoff: { type: 'fixed', delay: 15_000 } },
    })
    await tx.update(reportRuns).set({ jobId }).where(eq(reportRuns.id, id))
    await publishEvent(tx, ctx, {
      type: 'report.run_queued',
      object: await reportObject(tx, input.reportId),
      payload: { runId: id, trigger: input.trigger, runAs: input.runAs },
    })
    return id
  },

  /** Запуск, который не нужен: получатель расписания не видит отчёт. */
  async recordSkipped(
    tx: Executor,
    ctx: Ctx,
    input: EnqueueRunInput & { reason: string },
  ): Promise<string> {
    const id = newId()
    await tx.insert(reportRuns).values({
      id,
      reportId: input.reportId,
      trigger: input.trigger,
      runAs: input.runAs,
      requestedBy: input.requestedBy,
      params: input.params as unknown as Record<string, unknown>,
      formats: input.formats,
      channels: input.channels,
      externalEmails: input.externalEmails ?? [],
      status: 'skipped',
      error: input.reason,
      finishedAt: sql`now()`,
    })
    await publishEvent(tx, ctx, {
      type: 'report.run_failed',
      object: await reportObject(tx, input.reportId),
      payload: {
        runId: id,
        trigger: input.trigger,
        runAs: input.runAs,
        error: input.reason,
        skipped: true,
      },
    })
    return id
  },

  /**
   * «Сформировать»: запуск под правами нажавшего. Один незаконченный запуск на
   * пользователя и отчёт — повторное нажатие не ставит второй рендер.
   */
  async start(ctx: UserCtx, reportId: string, input: ReportRunInput): Promise<ReportRunRecord> {
    const report = await ReportService.get(reportId)
    const formats = [...new Set(input.formats ?? report.settings.formats)]
    const params = input.params ?? report.params
    const id = await db().transaction(async (tx) => {
      // Запуски одного отчёта — по очереди: две вкладки не поставят два рендера
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`report-run:${reportId}`}))`)
      const active = await tx
        .select({ id: reportRuns.id, createdAt: reportRuns.createdAt })
        .from(reportRuns)
        .where(
          and(
            eq(reportRuns.reportId, reportId),
            eq(reportRuns.runAs, ctx.userId),
            eq(reportRuns.trigger, 'manual'),
            inArray(reportRuns.status, ACTIVE),
          ),
        )
      const live = active.filter(
        (run) => Date.now() - new Date(run.createdAt).getTime() < STALE_RUN_MS,
      )
      if (live.length > 0) throw errors.conflict('Отчёт уже формируется')
      for (const stale of active) {
        await ReportRuns.fail(tx, stale.id, 'Запуск не завершился вовремя', false)
      }
      // Версия, по которой сформирован отчёт (ADR-0164): только если шаблон менялся
      await ReportVersions.recordIfChanged(tx, ctx, reportId, 'run')
      return ReportRuns.enqueue(tx, ctx, {
        reportId,
        runAs: ctx.userId,
        requestedBy: ctx.userId,
        trigger: 'manual',
        params,
        formats,
        channels: [],
      })
    })
    return ReportRuns.get(ctx, id)
  },

  async get(ctx: UserCtx, runId: string): Promise<ReportRunRecord> {
    const row = await loadRun(runId)
    if (!row) throw errors.notFound('Запуск отчёта')
    const own = row.runAs === ctx.userId
    const manage = own
      ? true
      : (await authorize(ctx, 'manage', row.reportId, { soft: true })).allowed
    if (!manage) throw errors.notFound('Запуск отчёта')
    await authorize(ctx, 'view', row.reportId)
    const [record] = await toRecords([row], ctx.userId)
    if (!record) throw errors.notFound('Запуск отчёта')
    return record
  },

  /** История запусков: свои; управляющему отчётом — все (без права скачивать чужие файлы). */
  async list(ctx: UserCtx, reportId: string): Promise<ReportRunRecord[]> {
    const manage = (await authorize(ctx, 'manage', reportId, { soft: true })).allowed
    const rows = await db()
      .select()
      .from(reportRuns)
      .where(
        manage
          ? eq(reportRuns.reportId, reportId)
          : and(eq(reportRuns.reportId, reportId), eq(reportRuns.runAs, ctx.userId)),
      )
      .orderBy(desc(reportRuns.createdAt))
      .limit(HISTORY_LIMIT)
    return toRecords(rows, ctx.userId)
  },

  /**
   * Ссылка на файл: только тому, под чьими правами он построен (другой человек
   * увидел бы чужие строки), пока у него есть `view` на отчёт.
   */
  async download(ctx: UserCtx, runId: string, format: ReportFormat): Promise<{ url: string }> {
    const row = await loadRun(runId)
    if (!row || row.runAs !== ctx.userId) throw errors.notFound('Запуск отчёта')
    await authorize(ctx, 'view', row.reportId)
    if (row.status !== 'succeeded') throw errors.conflict('Отчёт ещё не сформирован')
    const file = filesOf(row).find((item) => item.format === format)
    if (!file) throw errors.notFound('Файл отчёта')
    try {
      await headObject(file.key, buckets.exports())
    } catch {
      throw new AppError('not_found', 'Файл отчёта удалён: он хранится 30 дней', 404)
    }
    return {
      url: await signedGetUrl(file.key, { bucket: buckets.exports(), filename: file.fileName }),
    }
  },

  /**
   * Данные страницы печати запуска: тому, под чьими правами он строится, — его
   * браузеру или браузеру движка с токеном этого запуска.
   */
  async printPayload(ctx: UserCtx, runId: string): Promise<ReportPrintPayload> {
    const row = await loadRun(runId)
    if (!row || row.runAs !== ctx.userId) throw errors.notFound('Запуск отчёта')
    if (ctx.print && ctx.print.scope !== scopeOf(runId)) throw errors.notFound('Запуск отчёта')
    await authorize(ctx, 'view', row.reportId)
    const report = await ReportService.get(row.reportId)
    return {
      report: {
        id: report.id,
        name: report.name,
        blocks: report.blocks,
        settings: report.settings,
      },
      params: ReportParams.safeParse(row.params).data ?? report.params,
      run: { id: row.id, trigger: row.trigger as ReportRunTrigger, createdAt: row.createdAt },
      user: userOf(ctx),
      generatedAt: new Date().toISOString(),
    }
  },

  /** Предпросмотр печати текущего шаблона — в браузере пользователя, не движка. */
  async previewPayload(ctx: UserCtx, reportId: string): Promise<ReportPrintPayload> {
    if (ctx.print) throw errors.notFound('Отчёт')
    const report = await ReportService.get(reportId)
    return {
      report: {
        id: report.id,
        name: report.name,
        blocks: report.blocks,
        settings: report.settings,
      },
      params: report.params,
      run: null,
      user: userOf(ctx),
      generatedAt: new Date().toISOString(),
    }
  },

  // ─── Движок ────────────────────────────────────────────────────────────────

  /**
   * Движок взял задание: права того, под кем строится отчёт, проверяются заново
   * (они могли измениться, пока задание ждало очереди), выдаётся служебный
   * токен страницы печати. Нет доступа — запуск пропущен, рендера нет.
   */
  async engineStart(runId: string): Promise<ReportRenderStart> {
    const row = await loadRun(runId)
    if (!row || !ACTIVE.includes(row.status as ReportRunStatus)) {
      return { status: 'skip', reason: 'run_finished' }
    }
    const ctx = await runAsCtx(row.runAs, row.reportId)
    if (!ctx) {
      await db().transaction((tx) => ReportRuns.fail(tx, runId, 'Нет доступа к отчёту', true))
      return { status: 'skip', reason: 'no_access' }
    }
    const report = await ReportService.get(row.reportId)
    const formats = formatsOf(row)
    const t = createTranslator(ctx.locale as Locale)
    const date = isoDateIn(new Date(), ctx.timezone)
    const files = formats.map((format) => ({
      format,
      key: `reports/${row.reportId}/${runId}/report.${format}`,
      fileName: reportFileName(report.name, date, format),
      contentType: REPORT_CONTENT_TYPES[format],
    }))
    await db().transaction(async (tx) => {
      // Номер попытки считает api: повтор BullMQ приходит тем же запросом движка
      const [started] = await tx
        .update(reportRuns)
        .set({
          status: 'running',
          attempts: sql`${reportRuns.attempts} + 1`,
          startedAt: sql`now()`,
          error: null,
        })
        .where(eq(reportRuns.id, runId))
        .returning({ attempt: reportRuns.attempts })
      await publishEvent(tx, systemCtx('report.render', { initiatorId: row.runAs }), {
        type: 'report.run_started',
        object: await reportObject(tx, row.reportId),
        payload: { runId, attempt: started?.attempt ?? 1 },
      })
    })
    const { token } = await PrintGrants.issue({ userId: row.runAs, scope: scopeOf(runId) })
    return {
      status: 'render',
      token,
      printPath: `/print/report/${runId}`,
      locale: ctx.locale as Locale,
      timezone: ctx.timezone,
      title: report.name,
      pageSize: report.settings.pageSize,
      orientation: report.settings.orientation,
      header: report.settings.header || report.name,
      footer: report.settings.footer,
      labels: { page: t('data.report.print.page'), of: t('data.report.print.of') },
      bucket: buckets.exports(),
      files,
    }
  },

  /** Движок положил файлы: запуск готов, `report.generated` — рассылке и уведомлению. */
  async engineRendered(runId: string, result: ReportRenderResult): Promise<void> {
    const row = await loadRun(runId)
    if (!row) throw errors.notFound('Запуск отчёта')
    if (row.status !== 'running') throw errors.conflict('Запуск отчёта не выполняется')
    const prefix = `reports/${row.reportId}/${runId}/`
    const report = await ReportService.get(row.reportId)
    const [owner] = await db()
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, row.runAs))
      .limit(1)
    // Имя файла — то же, что выдал engineStart: дата начала в поясе получателя
    const date = isoDateIn(new Date(row.startedAt ?? row.createdAt), owner?.timezone ?? 'UTC')
    const byFormat = new Map<ReportFormat, StoredRunFile>()
    for (const file of result.files) {
      if (!file.key.startsWith(prefix)) throw errors.validation('Файл отчёта вне каталога запуска')
      byFormat.set(file.format, {
        format: file.format,
        key: file.key,
        fileName: reportFileName(report.name, date, file.format),
        size: file.size,
      })
    }
    const files = [...byFormat.values()]
    await db().transaction(async (tx) => {
      await tx
        .update(reportRuns)
        .set({
          status: 'succeeded',
          files,
          pages: result.pages,
          durationMs: result.durationMs,
          error: null,
          finishedAt: sql`now()`,
        })
        .where(eq(reportRuns.id, runId))
      await publishEvent(tx, systemCtx('report.render', { initiatorId: row.runAs }), {
        type: 'report.generated',
        object: await reportObject(tx, row.reportId),
        payload: {
          runId,
          trigger: row.trigger as ReportRunTrigger,
          runAs: row.runAs,
          formats: files.map((file) => file.format),
          pages: result.pages,
          size: files.reduce((sum, file) => sum + file.size, 0),
        },
      })
      // Файл отчёта — выгрузка данных с правами получателя: в аудит, как экспорт датасета
      await audit(
        systemCtx('report.render', { initiatorId: row.runAs }),
        {
          action: 'report.generated',
          objectId: row.reportId,
          objectType: 'report',
          severity: 'notice',
          details: {
            runId,
            trigger: row.trigger,
            formats: files.map((file) => file.format),
            pages: result.pages,
          },
        },
        tx,
      )
    })
    await PrintGrants.revoke(scopeOf(runId))
    logger().info(
      { runId, reportId: row.reportId, durationMs: result.durationMs, timings: result.timings },
      'отчёт сформирован',
    )
  },

  /**
   * Запуск не выполнен (окончательный сбой задания, нет доступа, завис):
   * статус, причина, `report.run_failed`; служебный токен отзывается.
   */
  async fail(tx: Executor, runId: string, message: string, skipped: boolean): Promise<void> {
    const [row] = await tx
      .update(reportRuns)
      .set({
        status: skipped ? 'skipped' : 'failed',
        error: message.slice(0, 1000),
        finishedAt: sql`now()`,
      })
      .where(and(eq(reportRuns.id, runId), inArray(reportRuns.status, ACTIVE)))
      .returning()
    if (!row) return
    await publishEvent(tx, systemCtx('report.render', { initiatorId: row.runAs }), {
      type: 'report.run_failed',
      object: await reportObject(tx, row.reportId),
      payload: {
        runId,
        trigger: row.trigger as ReportRunTrigger,
        runAs: row.runAs,
        error: message.slice(0, 1000),
        skipped,
      },
    })
    await PrintGrants.revoke(scopeOf(runId))
  },

  /** Файлы готового запуска — для рассылки. */
  async files(runId: string): Promise<{ row: RunRow; files: StoredRunFile[] } | null> {
    const row = await loadRun(runId)
    return row ? { row, files: filesOf(row) } : null
  },

  /** Итог доставки по каналам — в запись запуска. */
  async recordDelivery(
    tx: Executor,
    runId: string,
    delivery: Partial<Record<ReportDeliveryChannel, ReportDeliveryStatus>>,
  ): Promise<void> {
    await tx.update(reportRuns).set({ delivery }).where(eq(reportRuns.id, runId))
  },
}

function userOf(ctx: UserCtx): ReportPrintPayload['user'] {
  return {
    id: ctx.userId,
    displayName: ctx.displayName,
    locale: ctx.locale as Locale,
    timezone: ctx.timezone,
    canSql: ctx.capabilities.has('data.sql'),
  }
}
