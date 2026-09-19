import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { expect, openWorkspace, test } from './fixtures.js'
import { createReportData, pdfPages } from './report-data.js'

/**
 * Порт поддельного Bot API: api запущен с `TELEGRAM_BOT_TOKEN=7000001:fake-token-for-e2e`,
 * `TELEGRAM_API_URL=http://127.0.0.1:<порт>` и `TELEGRAM_POLLING=true`, движок — с
 * Chromium и доступом к вебу (ADR-0078); прогон — с `KCHS_E2E_TELEGRAM_PORT=<порт>`
 * и `KCHS_E2E_REPORTS=1`. Без этого сценарий пропускается.
 */
const PORT = Number(process.env.KCHS_E2E_TELEGRAM_PORT || 0)
const ENABLED = process.env.KCHS_E2E_REPORTS === '1' && PORT > 0
const TOKEN = '7000001:fake-token-for-e2e'
const CHAT_ID = 424_242

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Call {
  method: string
  body: Buffer
}

/**
 * Сценарий приёмки фазы 2 №6, часть отчётов (04-verification.md §3): тетрадь →
 * «В отчёт» → в отчёт добавлена карта → рассылка по расписанию (ежедневно, через
 * две минуты) получателю с привязанным Telegram → планировщик (BullMQ) ставит
 * рендер под правами получателя → движок печатает PDF со страницы печати → бот
 * присылает документ. PDF — с графиками и картой (картинки в файле).
 */
test.describe('Отчёты: экспорт из тетради и рассылка по расписанию в Telegram', () => {
  test.skip(
    !ENABLED,
    'нужны движок с Chromium и поддельный Bot API — KCHS_E2E_REPORTS=1 и KCHS_E2E_TELEGRAM_PORT',
  )
  let server: Server
  const calls: Call[] = []
  const updates: Array<Record<string, unknown>> = []
  let messageId = 0

  test.beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? '')
        const method = match?.[2] ?? ''
        calls.push({ method, body })
        const ok = (result: unknown) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, result }))
        }
        if (match?.[1] !== TOKEN) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
          return
        }
        const json = () => {
          try {
            return JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
          } catch {
            return {}
          }
        }
        switch (method) {
          case 'getMe':
            ok({ id: 7000001, is_bot: true, first_name: 'kchs', username: 'kchs_e2e_bot' })
            return
          case 'deleteWebhook':
            ok(true)
            return
          case 'getUpdates': {
            const offset = Number(json().offset ?? 0)
            const ready = updates.filter((update) => Number(update.update_id) >= offset)
            if (ready.length > 0) {
              ok(ready)
              return
            }
            setTimeout(() => ok([]), 300)
            return
          }
          case 'sendMessage':
          case 'sendDocument':
            messageId += 1
            ok({
              message_id: messageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: CHAT_ID, type: 'private' },
            })
            return
          default:
            response.writeHead(404, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  })

  test.afterAll(async () => {
    // Долгий опрос api держит соединения открытыми — закрыть их, иначе close ждёт
    server?.closeAllConnections()
    await new Promise((resolve) => server?.close(resolve))
  })

  test('тетрадь → «В отчёт» → карта → расписание → PDF от бота', async ({ page, request }) => {
    test.setTimeout(480_000)
    const run = Date.now().toString(36)

    // Опрос api дошёл до поддельного Bot API (после сбоя соединения он ждёт до минуты)
    await expect
      .poll(() => calls.filter((call) => call.method === 'getUpdates').length, {
        timeout: 100_000,
        intervals: [1000],
      })
      .toBeGreaterThan(0)

    // Администратор привязывает Telegram одноразовой ссылкой, как в профиле
    const data = await createReportData(request, run, { rows: 300, charts: 2 })
    const link = await request.post('/api/v1/me/telegram/link', { headers: data.headers })
    expect(link.ok(), await link.text()).toBeTruthy()
    const start = new URL((await link.json()).url as string).searchParams.get('start') ?? ''
    updates.push({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: 'private', first_name: 'Админ' },
        from: { id: CHAT_ID, is_bot: false, first_name: 'Админ', language_code: 'ru' },
        text: `/start ${start}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    })
    await expect
      .poll(async () => (await (await request.get('/api/v1/me/telegram')).json()).linked, {
        timeout: 30_000,
      })
      .toBe(true)

    // Тетрадь аналитика: текст, график, показатель и запрос графиком
    const notebookName = `Тетрадь обстановки ${run}`
    const notebook = await request.post('/api/v1/notebooks', {
      headers: data.headers,
      data: {
        name: notebookName,
        spaceId: data.spaceId,
        cells: [
          {
            id: 'intro',
            kind: 'text',
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: `Обстановка за неделю ${run}` }],
                },
              ],
            },
          },
          { id: 'chart', kind: 'chart', chartId: data.chartIds[0] },
          { id: 'metric', kind: 'metric', metricId: data.metricId },
          {
            id: 'by_kind',
            kind: 'query',
            title: 'Происшествия по видам',
            datasetId: data.datasetId,
            plan: {
              filter: null,
              groups: [{ field: 'kind' }],
              measures: [{ agg: 'count' }],
              sort: null,
              limit: null,
            },
            view: 'chart',
            chartType: 'bar',
          },
        ],
      },
    })
    expect(notebook.ok(), await notebook.text()).toBeTruthy()
    const notebookId = (await notebook.json()).id as string

    // «В отчёт» на экране тетради — открывается вкладка нового отчёта
    await openWorkspace(page, request)
    await page.goto(`/o/${notebookId}`)
    await expect(page.getByRole('tab', { name: new RegExp(notebookName) })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'В отчёт' }).click()
    await expect(page.getByText('Отчёт создан из тетради')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Сформировать' })).toBeVisible({
      timeout: 20_000,
    })
    // Адрес страницы — вкладка отчёта (/o/<id>), не тетради
    await expect(page).not.toHaveURL(new RegExp(notebookId))
    const reportId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
    expect(reportId).toBeTruthy()
    // Блоки тетради перенеслись: запрос по видам — со своей подписью
    await expect(page.getByRole('region', { name: /Запрос — блок 4/ })).toBeVisible()

    // Карта в отчёт: блок «Карта» и сохранённая карта
    await page.getByRole('button', { name: 'Добавить блок' }).click()
    await page.getByRole('menuitem', { name: 'Карта' }).click()
    const mapBlock = page.getByRole('region', { name: /Карта — блок 5/ })
    await mapBlock.getByRole('combobox', { name: 'Выберите карту' }).click()
    await page.getByRole('option', { name: data.mapName }).click()
    await expect(mapBlock.locator('[data-map-state]')).toHaveAttribute('data-map-state', 'idle', {
      timeout: 30_000,
    })

    // Снимок совместного документа записан: пять блоков, последний — карта
    await expect
      .poll(
        async () => {
          const record = await (await request.get(`/api/v1/reports/${reportId}`)).json()
          const blocks = record.blocks as Array<{ kind: string; mapId?: string | null }>
          return blocks.map((block) => (block.kind === 'map' ? `map:${block.mapId}` : block.kind))
        },
        { timeout: 30_000 },
      )
      .toEqual(['text', 'chart', 'metrics', 'query', `map:${data.mapId}`])

    // Рассылка: ежедневно через две минуты по поясу Душанбе, получатель — я, Telegram
    const at = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dushanbe',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(Date.now() + 2 * 60_000))
    await page.getByRole('button', { name: 'Рассылка' }).click()
    const dialog = page.getByRole('dialog', { name: 'Расписание и рассылка' })
    await dialog.getByRole('radio', { name: 'Ежедневно' }).click()
    await dialog.getByLabel('Время').fill(at)
    await expect(dialog.getByLabel('Часовой пояс')).toHaveValue('Asia/Dushanbe')
    // Получатель — сам администратор по имени: на общем стенде «Администраторов» много
    // (их создают прогоны приёмки фазы 0), а Telegram привязан только у него
    const me = (await (await request.get('/api/v1/me')).json()).user as {
      id: string
      displayName: string
    }
    await dialog.getByRole('searchbox', { name: 'Добавить получателя' }).fill(me.displayName)
    // Кнопка результата — аватар с инициалами, имя и подпись: имя ищется подстрокой,
    // а что выбран именно он, проверяют получатели сохранённого расписания
    await dialog
      .getByRole('list', { name: 'Добавить получателя' })
      .getByRole('button', { name: new RegExp(escapeRegExp(me.displayName)) })
      .first()
      .click()
    await dialog.getByRole('checkbox', { name: 'Telegram' }).click()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Расписание сохранено')).toBeVisible()
    const schedule = (await (await request.get(`/api/v1/reports/${reportId}/schedule`)).json())
      .schedule
    expect(schedule.pattern).toBe(`${Number(at.slice(3))} ${Number(at.slice(0, 2))} * * *`)
    expect(schedule.channels).toEqual(['inbox', 'telegram'])
    expect(schedule.recipients).toEqual([me.id])

    // Планировщик срабатывает в назначенную минуту — бот присылает PDF
    await expect
      .poll(() => calls.filter((call) => call.method === 'sendDocument').length, {
        timeout: 240_000,
        intervals: [2000],
      })
      .toBeGreaterThan(0)
    const sent = calls.find((call) => call.method === 'sendDocument') as Call
    const raw = sent.body.toString('latin1')
    expect(raw).toContain(`name="chat_id"\r\n\r\n${CHAT_ID}`)
    expect(raw).toContain('%PDF-')
    expect(
      Buffer.from(raw.match(/filename=([^\r]*)/)?.[1] ?? '', 'latin1').toString('utf8'),
    ).toMatch(/\.pdf$/)

    // Запуск по расписанию — под правами получателя; файл — с графиками и картой
    const runs = (await (await request.get(`/api/v1/reports/${reportId}/runs`)).json())
      .items as Array<{
      id: string
      trigger: string
      status: string
      delivery: Record<string, string>
    }>
    const scheduled = runs.find((item) => item.trigger === 'schedule')
    expect(scheduled?.status).toBe('succeeded')
    expect(scheduled?.delivery).toMatchObject({ telegram: 'sent', inbox: 'sent' })
    const download = await request.get(`/api/v1/reports/runs/${scheduled?.id}/download?format=pdf`)
    const pdf = Buffer.from(await (await fetch((await download.json()).url)).arrayBuffer())
    expect(pdfPages(pdf)).toBeGreaterThanOrEqual(1)
    // Два графика (сохранённый и запрос по видам) и карта — картинками в PDF
    const images = pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []
    expect(images.length).toBeGreaterThanOrEqual(3)

    // История запусков на экране отчёта (обновляется сама): «По расписанию», «Готов»
    const history = page.getByRole('list', { name: 'Запуски' })
    await expect(history.getByText('По расписанию').first()).toBeVisible({ timeout: 30_000 })
    await expect(history.getByText('Готов').first()).toBeVisible()
    await page.screenshot({ path: 'test-results/reports-schedule-telegram.png' })
  })
})
