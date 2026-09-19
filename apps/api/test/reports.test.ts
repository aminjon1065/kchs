import { PutObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { type FakeTelegram, startFakeTelegram } from './fakes.js'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Отчёты (P2-E05 S03–S05, ADR-0078): шаблон из блоков, «Экспорт в отчёт» из
 * тетради, запуск рендера движком со служебным токеном страницы печати, файлы в
 * бакете экспортов, скачивание только тому, под чьими правами построен файл,
 * расписание (планировщик BullMQ) и рассылка каждому получателю под его
 * правами — Входящие, почта с вложением, документ от бота Telegram. Движок
 * заменён его вызовами внутренних маршрутов, как в тестах импорта.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')
const { ReportService } = await import('../src/modules/reports/domain/report-service.js')
const { readReport, reportState, insertReportBlocks } = await import(
  '../src/modules/reports/domain/report-doc.js'
)
const { ReportRuns } = await import('../src/modules/reports/domain/run-service.js')
const { ReportSchedules } = await import('../src/modules/reports/domain/schedule-service.js')
const { ReportDelivery } = await import('../src/modules/reports/domain/delivery.js')
const { queue } = await import('../src/kernel/jobs/service.js')
const { s3, buckets } = await import('../src/kernel/storage/s3.js')
const { systemCtx } = await import('../src/shared/context.js')
const { TelegramLinks } = await import('../src/modules/telegram/domain/links.js')
const { config } = await import('../src/shared/config/index.js')

let fx: TestContext
let telegram: FakeTelegram
let datasetId: string
let chartId: string
let metricId: string
let reportId: string
const run = Date.now().toString(36)
const SERVICE = { 'x-kchs-service-token': '' }
const MEMBER_CHAT = 7770001

function configure(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
}

async function outbox(objectId: string, prefix = 'report.'): Promise<string[]> {
  const rows = await db().execute<{ type: string }>(
    sql`SELECT type FROM ops.outbox WHERE event->'object'->>'id' = ${objectId} ORDER BY id`,
  )
  return rows.map((row) => row.type).filter((type) => type.startsWith(prefix))
}

/** Запрос страницы печати или данных — как браузер движка: только cookie токена. */
function asPrint(token: string, options: Parameters<typeof call>[1]) {
  return call(fx.app, {
    ...options,
    headers: { cookie: `kchs_print=${token}`, ...options.headers },
  })
}

async function engineStart(runId: string) {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/internal/reports/runs/${runId}/start`,
    payload: {},
    headers: SERVICE,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** Движок положил файлы в бакет экспортов и сообщил об этом api. */
async function engineRender(
  runId: string,
  plan: { files: Array<{ format: string; key: string }> },
) {
  const files: Array<{ format: string; key: string; size: number }> = []
  for (const file of plan.files) {
    const body = Buffer.from(
      file.format === 'pdf' ? '%PDF-1.7\n1 0 obj << /Type /Page >> endobj\n%%EOF' : 'PK docx',
    )
    await s3().send(new PutObjectCommand({ Bucket: buckets.exports(), Key: file.key, Body: body }))
    files.push({ format: file.format, key: file.key, size: body.byteLength })
  }
  const response = await call(fx.app, {
    method: 'POST',
    url: `/internal/reports/runs/${runId}/rendered`,
    payload: { files, pages: 1, durationMs: 1234, timings: { ready: 900, pdf: 300 } },
    headers: SERVICE,
  })
  expect(response.statusCode, response.body).toBe(200)
}

beforeAll(async () => {
  fx = await setupFixture()
  SERVICE['x-kchs-service-token'] = config().INTERNAL_SERVICE_TOKEN ?? ''
  telegram = await startFakeTelegram()
  configure({
    TELEGRAM_BOT_TOKEN: telegram.token,
    TELEGRAM_API_URL: telegram.url,
    TELEGRAM_POLLING: 'false',
  })

  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Паводки ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
      ],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id
  const chart = await call(fx.app, {
    method: 'POST',
    url: '/charts',
    as: fx.admin,
    payload: {
      name: `Паводки по районам ${run}`,
      spaceId: fx.spaceId,
      spec: {
        version: 1,
        type: 'table',
        data: { query: { version: 1, source: { kind: 'dataset', id: datasetId }, steps: [] } },
        encoding: {},
      },
    },
  })
  expect(chart.statusCode, chart.body).toBe(200)
  chartId = chart.json().id
  const metric = await call(fx.app, {
    method: 'POST',
    url: '/metrics',
    as: fx.admin,
    payload: {
      name: `Число паводков ${run}`,
      spaceId: fx.spaceId,
      datasetId,
      definition: { measure: { agg: 'count' }, period: null },
    },
  })
  expect(metric.statusCode, metric.body).toBe(200)
  metricId = metric.json().id
})

afterAll(async () => {
  configure({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_API_URL: undefined })
  await telegram?.close()
})

describe('шаблон отчёта', () => {
  it('создаётся из блоков: снимок, зависимости «Используется в», документ Yjs', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/reports',
      as: fx.admin,
      payload: {
        name: `Сводка ${run}`,
        spaceId: fx.spaceId,
        blocks: [
          {
            id: 'intro',
            kind: 'text',
            body: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Обстановка' }] }],
            },
          },
          { id: 'q1', kind: 'query', datasetId, view: 'table', maxRows: 20 },
          { id: 'c1', kind: 'chart', chartId, view: 'table' },
          { id: 'm1', kind: 'metrics', metricIds: [metricId] },
          { id: 'brk', kind: 'page_break' },
          { id: 'map1', kind: 'map', source: 'map', mapId: null },
        ],
        params: { period: { unit: 'month', from: -1, to: -1 }, territory: null },
        settings: { orientation: 'landscape', footer: 'КЧС', formats: ['pdf', 'docx'] },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    reportId = response.json().id

    const record = await call(fx.app, { url: `/reports/${reportId}`, as: fx.users.viewer })
    expect(record.statusCode, record.body).toBe(200)
    const body = record.json()
    expect(body.blocks.map((block: { kind: string }) => block.kind)).toEqual([
      'text',
      'query',
      'chart',
      'metrics',
      'page_break',
      'map',
    ])
    expect(body.blocks[1]).toMatchObject({ maxRows: 20, mode: 'visual', size: 'medium' })
    expect(body.settings).toMatchObject({ orientation: 'landscape', footer: 'КЧС', header: '' })
    expect(body.params.period).toEqual({ unit: 'month', from: -1, to: -1 })
    expect(body.scheduled).toBe(false)

    const deps = await db().execute<{ to_id: string }>(
      sql`SELECT to_id FROM dependencies WHERE from_id = ${reportId} ORDER BY to_id`,
    )
    expect(deps.map((row) => row.to_id).sort()).toEqual([chartId, datasetId, metricId].sort())
    const state = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM yjs.documents WHERE object_id = ${reportId}`,
    )
    expect(state[0]?.n).toBe(1)
  })

  it('ссылки блоков — только на то, что автор видит', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/reports',
      as: fx.users.stranger,
      payload: {
        name: 'Чужие данные',
        spaceId: fx.orgSpaceId,
        blocks: [{ id: 'c1', kind: 'chart', chartId }],
      },
    })
    expect([403, 404]).toContain(response.statusCode)
  })

  it('снимок совместного документа: блоки, настройки, событие report.updated', async () => {
    const report = await ReportService.get(reportId)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, reportState(report))
    doc.transact(() => {
      insertReportBlocks(doc, [
        { id: 'tail', kind: 'text', title: null, body: { type: 'doc', content: [] } },
      ])
      doc.getMap('settings').set('orientation', 'portrait')
      // Значение вне контракта — настройка по умолчанию, блок-чужак — мимо снимка
      doc.getMap('settings').set('formats', ['exe'])
      const alien = new Y.Map<unknown>()
      alien.set('kind', 'script')
      doc.getMap('cells').set('x', alien)
      doc.getArray('order').push(['x'])
    })
    expect(readReport(doc).blocks.map((block) => block.id)).toContain('tail')
    await db().transaction((tx) =>
      ReportService.snapshot(tx, systemCtx('test', { initiatorId: fx.admin.id }), reportId, doc),
    )
    const after = await ReportService.get(reportId)
    expect(after.blocks.at(-1)?.id).toBe('tail')
    expect(after.blocks.some((block) => block.id === 'x')).toBe(false)
    expect(after.settings.orientation).toBe('portrait')
    expect(after.settings.formats).toEqual(['pdf'])
    expect(await outbox(reportId)).toContain('report.updated')
  })

  it('«Экспорт в отчёт» из тетради: ячейки → блоки, параметры, связь «Источник»', async () => {
    const notebook = await call(fx.app, {
      method: 'POST',
      url: '/notebooks',
      as: fx.admin,
      payload: {
        name: `Тетрадь ${run}`,
        spaceId: fx.spaceId,
        cells: [
          {
            id: 'n1',
            kind: 'text',
            body: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Вывод' }] }],
            },
          },
          { id: 'n2', kind: 'query', datasetId, view: 'chart', chartType: 'bar' },
          {
            id: 'n3',
            kind: 'ai',
            datasetId,
            question: 'сколько паводков',
            answer: { title: 'Паводки', explanation: 'число' },
          },
          { id: 'n4', kind: 'metric', metricId },
          { id: 'n5', kind: 'chart', chartId },
        ],
        params: { period: { unit: 'year', from: 0, to: 0 }, territory: null },
      },
    })
    expect(notebook.statusCode, notebook.body).toBe(200)
    const notebookId = notebook.json().id

    // Читатель пространства не может создавать объекты — и отчёт из тетради тоже
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/reports/from-notebook',
      as: fx.users.viewer,
      payload: { notebookId },
    })
    expect(denied.statusCode).toBe(403)

    const response = await call(fx.app, {
      method: 'POST',
      url: '/reports/from-notebook',
      as: fx.users.member,
      payload: { notebookId, name: `Отчёт из тетради ${run}` },
    })
    expect(response.statusCode, response.body).toBe(200)
    const created = (
      await call(fx.app, { url: `/reports/${response.json().id}`, as: fx.users.member })
    ).json()
    expect(created.name).toBe(`Отчёт из тетради ${run}`)
    expect(created.blocks.map((block: { kind: string }) => block.kind)).toEqual([
      'text',
      'query',
      'query',
      'metrics',
      'chart',
    ])
    expect(created.blocks[1]).toMatchObject({ view: 'chart', chartType: 'bar', datasetId })
    expect(created.blocks[2].title).toBe('Паводки')
    expect(created.blocks[3].metricIds).toEqual([metricId])
    expect(created.params.period).toEqual({ unit: 'year', from: 0, to: 0 })
    const links = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM links WHERE source_id = ${created.id} AND target_id = ${notebookId} AND kind = 'source'`,
    )
    expect(links[0]?.n).toBe(1)
  })
})

describe('запуск и печать', () => {
  let runId: string
  let token: string

  it('«Сформировать»: запуск под правами нажавшего, задание движка, повтор — 409', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.users.viewer,
      payload: { formats: ['pdf', 'docx'] },
    })
    expect(response.statusCode, response.body).toBe(200)
    const record = response.json()
    runId = record.id
    expect(record).toMatchObject({
      status: 'queued',
      trigger: 'manual',
      formats: ['pdf', 'docx'],
      canDownload: false,
    })
    expect(record.runAs.id).toBe(fx.users.viewer.id)
    const jobs = await db().execute<{ queue: string; name: string; payload: { runId: string } }>(
      sql`SELECT queue, name, payload FROM jobs WHERE object_id = ${reportId} ORDER BY created_at DESC LIMIT 1`,
    )
    expect(jobs[0]).toMatchObject({ queue: 'render', name: 'report.render', payload: { runId } })

    const again = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(again.statusCode).toBe(409)
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.users.stranger,
      payload: {},
    })
    expect(stranger.statusCode).toBe(404)
    expect(await outbox(reportId)).toContain('report.run_queued')
  })

  it('движок: без сервисного токена — 401; с ним — токен печати и файлы запуска', async () => {
    const anonymous = await call(fx.app, {
      method: 'POST',
      url: `/internal/reports/runs/${runId}/start`,
      payload: {},
    })
    expect(anonymous.statusCode).toBe(401)
    const plan = await engineStart(runId)
    expect(plan).toMatchObject({
      status: 'render',
      printPath: `/print/report/${runId}`,
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
      orientation: 'portrait',
      header: `Сводка ${run}`,
      footer: 'КЧС',
      labels: { page: 'Страница', of: 'из' },
      bucket: buckets.exports(),
    })
    expect(plan.files.map((file: { format: string }) => file.format)).toEqual(['pdf', 'docx'])
    expect(plan.files[0].key).toBe(`reports/${reportId}/${runId}/report.pdf`)
    expect(plan.files[0].fileName).toMatch(/^Сводка .+ \d{4}-\d{2}-\d{2}\.pdf$/)
    token = plan.token
    expect(token).toMatch(/^p_/)
    const stored = await redis().keys('kchs:print:grant:*')
    expect(stored.length).toBeGreaterThan(0)
  })

  it('страница печати с токеном: данные с правами получателя, только чтение', async () => {
    const payload = await asPrint(token, { url: `/print/report-runs/${runId}` })
    expect(payload.statusCode, payload.body).toBe(200)
    expect(payload.json()).toMatchObject({
      report: { id: reportId, name: `Сводка ${run}` },
      run: { id: runId, trigger: 'manual' },
      user: { id: fx.users.viewer.id, locale: 'ru' },
    })
    // Запрос данных — POST только для чтения, доступен странице печати
    const query = await asPrint(token, {
      method: 'POST',
      url: '/queries/run',
      payload: { spec: { version: 1, source: { kind: 'dataset', id: datasetId }, steps: [] } },
    })
    expect(query.statusCode, query.body).toBe(200)
    // Изменения — нет: токен печати не сессия
    const write = await asPrint(token, {
      method: 'POST',
      url: '/reports',
      payload: { name: 'через печать', spaceId: fx.spaceId },
    })
    expect(write.statusCode).toBe(403)
    // Личные маршруты живут сессией: у страницы печати её нет
    expect((await asPrint(token, { url: '/me' })).statusCode).toBe(403)
    expect((await asPrint(token, { url: '/me/workspace-state' })).statusCode).toBe(403)
    // Предпросмотр и чужие запуски — не для токена печати
    expect((await asPrint(token, { url: `/print/reports/${reportId}` })).statusCode).toBe(404)
    const forged = await asPrint('p_forged', { url: `/print/report-runs/${runId}` })
    expect(forged.statusCode).toBe(401)
    // Сессия того же пользователя открывает свою печать; чужой запуск — нет
    const own = await call(fx.app, { url: `/print/report-runs/${runId}`, as: fx.users.viewer })
    expect(own.statusCode).toBe(200)
    const other = await call(fx.app, { url: `/print/report-runs/${runId}`, as: fx.admin })
    expect(other.statusCode).toBe(404)
  })

  it('файлы готовы: report.generated, токен отозван, скачивает только получатель', async () => {
    // Повтор задания движка: новый токен, прежний погашен
    const plan = await engineStart(runId)
    expect((await asPrint(token, { url: `/print/report-runs/${runId}` })).statusCode).toBe(401)
    await engineRender(runId, plan)
    const record = await call(fx.app, { url: `/reports/runs/${runId}`, as: fx.users.viewer })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json()).toMatchObject({
      status: 'succeeded',
      pages: 1,
      durationMs: 1234,
      canDownload: true,
    })
    expect(record.json().files.map((file: { format: string }) => file.format)).toEqual([
      'pdf',
      'docx',
    ])
    expect(await outbox(reportId)).toEqual(
      expect.arrayContaining(['report.run_started', 'report.generated']),
    )
    // Номер попытки считает api: повтор задания движка — вторая попытка
    const started = await db().execute<{ attempt: number }>(
      sql`SELECT (event->'payload'->>'attempt')::int AS attempt FROM ops.outbox
          WHERE type = 'report.run_started' AND event->'payload'->>'runId' = ${runId} ORDER BY id`,
    )
    expect(started.map((row) => row.attempt)).toEqual([1, 2])
    // Файл отчёта — выгрузка данных получателя: запись аудита от его имени
    const audited = await db().execute<{ actor_id: string; details: Record<string, unknown> }>(
      sql`SELECT actor_id, details FROM audit_log WHERE action = 'report.generated' AND object_id = ${reportId}`,
    )
    expect(audited[0]).toMatchObject({
      actor_id: fx.users.viewer.id,
      details: { runId, trigger: 'manual', formats: ['pdf', 'docx'], pages: 1 },
    })
    expect((await asPrint(plan.token, { url: `/print/report-runs/${runId}` })).statusCode).toBe(401)

    const link = await call(fx.app, {
      url: `/reports/runs/${runId}/download?format=pdf`,
      as: fx.users.viewer,
    })
    expect(link.statusCode, link.body).toBe(200)
    const file = await fetch(link.json().url)
    expect(file.ok).toBe(true)
    expect((await file.text()).startsWith('%PDF-')).toBe(true)
    expect(decodeURIComponent(file.headers.get('content-disposition') ?? '')).toContain('Сводка')

    // Управляющий отчётом видит запуск в истории, но файл построен с чужими правами
    const history = await call(fx.app, { url: `/reports/${reportId}/runs`, as: fx.admin })
    const item = history.json().items.find((entry: { id: string }) => entry.id === runId)
    expect(item).toMatchObject({ canDownload: false })
    const foreign = await call(fx.app, {
      url: `/reports/runs/${runId}/download?format=pdf`,
      as: fx.admin,
    })
    expect(foreign.statusCode).toBe(404)
    // Читатель в истории видит только свои запуски
    const mine = await call(fx.app, { url: `/reports/${reportId}/runs`, as: fx.users.viewer })
    expect(
      mine
        .json()
        .items.every((entry: { runAs: { id: string } }) => entry.runAs.id === fx.users.viewer.id),
    ).toBe(true)
  })

  it('сбой задания: запуск failed, событие, токен отозван', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.users.member,
      payload: {},
    })
    expect(started.statusCode, started.body).toBe(200)
    const failedRunId = started.json().id
    const plan = await engineStart(failedRunId)
    await db().transaction((tx) => ReportRuns.fail(tx, failedRunId, 'Chromium упал', false))
    const record = (
      await call(fx.app, { url: `/reports/runs/${failedRunId}`, as: fx.users.member })
    ).json()
    expect(record).toMatchObject({ status: 'failed', error: 'Chromium упал' })
    expect(
      (await asPrint(plan.token, { url: `/print/report-runs/${failedRunId}` })).statusCode,
    ).toBe(401)
    // Повтор задания после окончательного сбоя — пропуск, а не новый рендер
    expect(await engineStart(failedRunId)).toEqual({ status: 'skip', reason: 'run_finished' })
  })

  it('получатель потерял доступ к отчёту до рендера — запуск пропущен', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/runs`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(started.statusCode, started.body).toBe(200)
    const skippedRunId = started.json().id
    await db().execute(sql`UPDATE users SET status = 'blocked' WHERE id = ${fx.users.viewer.id}`)
    try {
      expect(await engineStart(skippedRunId)).toEqual({ status: 'skip', reason: 'no_access' })
    } finally {
      await db().execute(sql`UPDATE users SET status = 'active' WHERE id = ${fx.users.viewer.id}`)
    }
    const [row] = await db().execute<{ status: string }>(
      sql`SELECT status FROM report_runs WHERE id = ${skippedRunId}`,
    )
    expect(row?.status).toBe('skipped')
  })
})

describe('расписание и рассылка', () => {
  const schedule = () => ({
    frequency: 'weekly',
    time: '08:30',
    weekdays: [1, 7],
    timezone: 'Asia/Dushanbe',
    recipients: [fx.users.member.id, fx.users.stranger.id],
    channels: ['inbox', 'email', 'telegram'],
    formats: ['pdf'],
    params: { period: { unit: 'week', from: -1, to: -1 }, territory: null },
  })

  it('задаёт управляющий: выражение cron, ближайший запуск, получатели без доступа', async () => {
    const viewer = await call(fx.app, {
      method: 'PUT',
      url: `/reports/${reportId}/schedule`,
      as: fx.users.viewer,
      payload: schedule(),
    })
    expect(viewer.statusCode).toBe(403)

    const response = await call(fx.app, {
      method: 'PUT',
      url: `/reports/${reportId}/schedule`,
      as: fx.admin,
      payload: schedule(),
    })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.pattern).toBe('30 8 * * 0,1')
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now())
    expect(body.recipientsWithoutAccess).toEqual([fx.users.stranger.id])
    expect(body.recipientRefs.map((ref: { id: string }) => ref.id)).toEqual([
      fx.users.member.id,
      fx.users.stranger.id,
    ])
    expect(body.updatedBy.id).toBe(fx.admin.id)
    expect(
      (await call(fx.app, { url: `/reports/${reportId}`, as: fx.admin })).json().scheduled,
    ).toBe(true)
    expect(await outbox(reportId)).toContain('report.schedule_changed')
  })

  it('проверки: не чаще раза в час, пояс IANA, действующие получатели', async () => {
    const put = (payload: Record<string, unknown>) =>
      call(fx.app, {
        method: 'PUT',
        url: `/reports/${reportId}/schedule`,
        as: fx.admin,
        payload: { ...schedule(), ...payload },
      })
    expect((await put({ frequency: 'cron', cron: '*/5 * * * *' })).statusCode).toBe(400)
    expect((await put({ frequency: 'cron', cron: 'не cron' })).statusCode).toBe(400)
    expect((await put({ timezone: 'Mars/Olympus' })).statusCode).toBe(400)
    expect((await put({ recipients: ['00000000-0000-7000-8000-000000000000'] })).statusCode).toBe(
      400,
    )
    const cron = await put({ frequency: 'cron', cron: '0  9 1 * *' })
    expect(cron.statusCode, cron.body).toBe(200)
    expect(cron.json().pattern).toBe('0 9 1 * *')
    // Вернуть еженедельную рассылку
    expect((await put({})).statusCode).toBe(200)
  })

  it('планировщик BullMQ следует за расписанием и снимается вместе с ним', async () => {
    await ReportSchedules.sync(reportId)
    const automation = queue('automation')
    const scheduler = await automation.getJobScheduler(`report-${reportId}`)
    expect(scheduler).toMatchObject({ pattern: '30 8 * * 0,1', tz: 'Asia/Dushanbe' })
    expect(scheduler?.template?.data).toEqual({ reportId })
    expect(await ReportSchedules.syncAll()).toBeGreaterThanOrEqual(1)
  })

  it('запуск рассылки: по рендеру на получателя под его правами; без доступа — пропуск', async () => {
    const result = await ReportSchedules.fire(reportId)
    expect(result).toEqual({ runs: 1, skipped: 1 })
    const rows = await db().execute<{ run_as: string; status: string; channels: string[] }>(
      // Запуски одной рассылки — в одной транзакции: время одно, порядок — по статусу
      sql`SELECT run_as, status, channels FROM report_runs WHERE report_id = ${reportId} AND trigger = 'schedule' ORDER BY status`,
    )
    expect(rows.map((row) => [row.run_as, row.status])).toEqual([
      [fx.users.member.id, 'queued'],
      [fx.users.stranger.id, 'skipped'],
    ])
    expect(rows[0]?.channels).toEqual(['inbox', 'email', 'telegram'])
  })

  it('доставка: Входящие, письмо с PDF, документ от бота; итог — в запуске и событии', async () => {
    // Чат участника привязан к боту одноразовой ссылкой, как в профиле
    const link = await call(fx.app, {
      method: 'POST',
      url: '/me/telegram/link',
      as: fx.users.member,
    })
    expect(link.statusCode, link.body).toBe(200)
    const start = new URL(link.json().url).searchParams.get('start') ?? ''
    expect(
      await TelegramLinks.complete(start, { chatId: MEMBER_CHAT, username: 'member_tg' }),
    ).toMatchObject({ kind: 'linked' })

    const [row] = await db().execute<{ id: string }>(
      sql`SELECT id FROM report_runs WHERE report_id = ${reportId} AND trigger = 'schedule' AND status = 'queued' LIMIT 1`,
    )
    const scheduledRunId = row?.id as string
    const plan = await engineStart(scheduledRunId)
    // Рендер для получателя — под его правами: токен выдан на него
    const printed = await asPrint(plan.token, { url: `/print/report-runs/${scheduledRunId}` })
    expect(printed.json().user.id).toBe(fx.users.member.id)
    expect(printed.json().params.period).toEqual({ unit: 'week', from: -1, to: -1 })
    await engineRender(scheduledRunId, plan)
    await ReportDelivery.deliver(scheduledRunId)
    // Повтор подписчика не шлёт второй раз
    await ReportDelivery.deliver(scheduledRunId)

    const documents = telegram.documents()
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ chatId: MEMBER_CHAT, pdf: true })
    expect(documents[0]?.fileName).toMatch(/^Сводка .+\.pdf$/)
    expect(documents[0]?.caption).toContain(`Сводка ${run}`)

    const record = (
      await call(fx.app, { url: `/reports/runs/${scheduledRunId}`, as: fx.users.member })
    ).json()
    expect(record.delivery).toMatchObject({ inbox: 'sent', telegram: 'sent' })
    expect(['sent', 'unavailable']).toContain(record.delivery.email)
    expect(await outbox(reportId)).toContain('report.delivered')

    const inbox = await call(fx.app, { url: '/inbox?state=open', as: fx.users.member })
    const item = inbox
      .json()
      .items.find(
        (entry: { kind: string; object: { id: string } | null }) =>
          entry.kind === 'report' && entry.object?.id === reportId,
      )
    expect(item?.title).toContain(`Сводка ${run}`)
    const acted = await call(fx.app, {
      method: 'POST',
      url: `/inbox/${item.id}/act`,
      as: fx.users.member,
      payload: { action: 'acknowledge' },
    })
    expect(acted.statusCode, acted.body).toBe(200)
    const closed = await call(fx.app, { url: '/inbox?state=open', as: fx.users.member })
    expect(closed.json().items.some((entry: { id: string }) => entry.id === item.id)).toBe(false)
  })

  it('«Отправить сейчас» и снятие рассылки: планировщик снят', async () => {
    const now = await call(fx.app, {
      method: 'POST',
      url: `/reports/${reportId}/schedule/run`,
      as: fx.admin,
    })
    expect(now.statusCode, now.body).toBe(200)
    expect(now.json()).toEqual({ runs: 1, skipped: 1 })

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/reports/${reportId}/schedule`,
      as: fx.admin,
    })
    expect(removed.statusCode).toBe(200)
    await ReportSchedules.sync(reportId)
    expect(await queue('automation').getJobScheduler(`report-${reportId}`)).toBeFalsy()
    const got = await call(fx.app, { url: `/reports/${reportId}/schedule`, as: fx.admin })
    expect(got.json().schedule).toBeNull()
    // Рассылка снята — запуск по старому планировщику ничего не делает
    expect(await ReportSchedules.fire(reportId)).toEqual({ runs: 0, skipped: 0 })
  })
})
