import { createServer, type Server } from 'node:http'
import type { APIRequestContext, Page } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Приёмка фазы 2 — тетрадь и ИИ (04-verification.md §3 №6, сценарий F
 * продуктового описания). Модель — поддельный OpenAI-совместимый сервер этого
 * теста: api запущен с `AI_PROVIDER=openai-compat
 * OPENAI_COMPAT_URL=http://127.0.0.1:<порт>/v1 AI_MODEL=kchs-e2e`, прогон — с
 * `KCHS_E2E_AI_PORT=<порт>`; без этого сценарии пропускаются. Отчёт по
 * расписанию в Telegram (вторая половина №6) — reports-schedule-telegram.spec.ts.
 */
const PORT = Number(process.env.KCHS_E2E_AI_PORT || 0)

/** Ответ «модели» — план ADR-0061: количество по районам, по убыванию, столбцы. */
const ANSWER = {
  answerable: true,
  reason: '',
  title: 'Обращения по районам',
  explanation: 'Количество обращений по районам, по убыванию',
  conditions: [],
  groups: [{ field: 'district', bucket: null }],
  measures: [{ agg: 'count', field: null }],
  sort: { by: 'count', dir: 'desc' },
  limit: null,
  chart: 'bar',
}

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

interface RunSpace {
  headers: Record<string, string>
  spaceId: string
  datasetId: string
  datasetName: string
}

/**
 * Пространство прогона и датасет обращений по районам в нём; коллега (user001)
 * — участник с указанной ролью или вне пространства.
 */
async function runSpace(
  request: APIRequestContext,
  run: string,
  colleagueRole: 'editor' | null,
): Promise<RunSpace> {
  const headers = await csrf(request)
  const space = await request.post('/api/v1/spaces', {
    headers,
    data: { key: `nb-${run}`, name: `Аналитика ${run}` },
  })
  expect(space.ok(), await space.text()).toBeTruthy()
  const spaceId = (await space.json()).id as string
  if (colleagueRole) {
    const users = await request.get('/api/v1/users?q=user001')
    const colleague = (await users.json()).items[0] as { id: string }
    const joined = await request.post(`/api/v1/spaces/${spaceId}/members`, {
      headers,
      data: { userId: colleague.id, role: colleagueRole },
    })
    expect(joined.ok(), await joined.text()).toBeTruthy()
  }
  const datasetName = `Обращения ${run}`
  const created = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: datasetName,
      spaceId,
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const datasetId = (await created.json()).id as string
  const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
    headers,
    data: {
      rows: ['Бохтар', 'Бохтар', 'Бохтар', 'Куляб', 'Куляб', 'Вахш'].map((district, index) => ({
        values: { code: `N-${run}-${index}`, district, damage: index * 100 },
      })),
    },
  })
  expect(inserted.ok(), await inserted.text()).toBeTruthy()
  return { headers, spaceId, datasetId, datasetName }
}

async function createNotebook(
  request: APIRequestContext,
  space: RunSpace,
  name: string,
): Promise<string> {
  const notebook = await request.post('/api/v1/notebooks', {
    headers: space.headers,
    data: {
      name,
      spaceId: space.spaceId,
      cells: [
        { id: 'intro', kind: 'text', body: { type: 'doc', content: [{ type: 'paragraph' }] } },
      ],
    },
  })
  expect(notebook.ok(), await notebook.text()).toBeTruthy()
  return (await notebook.json()).id as string
}

/** Ячейка «Вопрос ИИ» в конце тетради: датасет, вопрос, ответ графиком и запрос. */
async function askInNotebook(page: Page, space: RunSpace, n: number, question: string) {
  await page.getByRole('button', { name: 'Добавить ячейку' }).click()
  await page.getByRole('menuitem', { name: 'Вопрос ИИ' }).click()
  const cell = page.getByRole('region', { name: `Вопрос ИИ — ячейка ${n}` })
  await cell.getByRole('combobox', { name: 'Датасет ячейки' }).click()
  await page.getByRole('option', { name: space.datasetName }).click()
  await cell.getByRole('textbox', { name: 'Вопрос к данным' }).fill(question)
  await cell.getByRole('button', { name: 'Спросить', exact: true }).click()
  await expect(cell.getByText(ANSWER.explanation)).toBeVisible({ timeout: 30_000 })
  // График ответа и запрос, который его построил: разрез — район, мера — количество
  await expect(cell.locator('canvas').first()).toBeVisible({ timeout: 20_000 })
  await cell.getByRole('button', { name: 'Показать запрос' }).click()
  await expect(cell.getByRole('combobox', { name: 'Разрезы' })).toHaveText('Район')
  return cell
}

/** «В отчёт»: вкладка нового отчёта; его блоки — по ячейкам тетради. */
async function exportToReport(page: Page, request: APIRequestContext, notebookId: string) {
  await page.getByRole('button', { name: 'В отчёт' }).click()
  await expect(page.getByText('Отчёт создан из тетради')).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(notebookId))
  const reportId = /\/o\/([0-9a-f-]{36})/.exec(page.url())?.[1] as string
  expect(reportId).toBeTruthy()
  const record = await (await request.get(`/api/v1/reports/${reportId}`)).json()
  return record as { blocks: Array<{ kind: string; title: string | null; datasetId?: string }> }
}

test.describe('Приёмка фазы 2: тетрадь и ИИ', () => {
  test.skip(!PORT, 'api без поддельного провайдера ИИ — задайте KCHS_E2E_AI_PORT (см. описание)')
  let server: Server
  const questions: string[] = []

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const messages = (JSON.parse(body || '{}').messages ?? []) as Array<{ content?: unknown }>
        questions.push(JSON.stringify(messages.at(-1)?.content ?? ''))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: `chatcmpl_${questions.length}`,
            object: 'chat.completion',
            model: 'kchs-e2e',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(ANSWER) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  })

  test.afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve))
  })

  test('№6: два аналитика правят тетрадь одновременно, ИИ-ячейка, «В отчёт»', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const space = await runSpace(request, run, 'editor')
    const name = `Совместная тетрадь ${run}`
    const notebookId = await createNotebook(request, space, name)
    const me = (await (await request.get('/api/v1/me')).json()).user as { displayName: string }
    const colleagueUser = (await (await request.get('/api/v1/users?q=user001')).json())
      .items[0] as { displayName: string }

    // Оба аналитика открывают тетрадь
    await openWorkspace(page, request)
    await page.goto(`/o/${notebookId}`)
    await expect(page.getByText('Все изменения сохранены')).toBeVisible({ timeout: 20_000 })
    const colleague = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(colleague.request)
    const other = await colleague.newPage()
    await other.goto(`/o/${notebookId}`)
    await expect(other.getByText('Все изменения сохранены')).toBeVisible({ timeout: 20_000 })

    // Текст пишут вдвоём: правки приходят соавтору, соавтор виден в ячейке
    const text = page.getByRole('region', { name: 'Текст — ячейка 1' })
    const otherText = other.getByRole('region', { name: 'Текст — ячейка 1' })
    await text.getByRole('textbox', { name: 'Текст' }).click()
    await page.keyboard.type(`Итоги недели ${run}.`)
    await expect(otherText).toContainText(`Итоги недели ${run}.`, { timeout: 15_000 })
    await expect(otherText.getByText(`Здесь: ${me.displayName}`)).toBeVisible()
    await otherText.getByRole('textbox', { name: 'Текст' }).click()
    await other.keyboard.press('End')
    await other.keyboard.type(' Проверено коллегой.')
    await expect(text).toContainText(`Итоги недели ${run}. Проверено коллегой.`, {
      timeout: 15_000,
    })
    await expect(text.getByText(`Здесь: ${colleagueUser.displayName}`)).toBeVisible()

    // ИИ-ячейка: вопрос на русском — график и запрос; ответ виден и соавтору
    await askInNotebook(page, space, 2, 'Сколько обращений по районам?')
    expect(questions.at(-1)).toContain('Сколько обращений по районам?')
    await expect(
      other.getByRole('region', { name: 'Вопрос ИИ — ячейка 2' }).getByText(ANSWER.explanation),
    ).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: 'test-results/acceptance-p2-6-notebook.png' })
    await colleague.close()

    // Снимок тетради записан, «В отчёт» переносит текст и ответ ИИ блоком запроса
    await expect
      .poll(
        async () => {
          const record = await (await request.get(`/api/v1/notebooks/${notebookId}`)).json()
          return (record.cells as Array<{ kind: string }>).map((cell) => cell.kind)
        },
        { timeout: 20_000 },
      )
      .toEqual(['text', 'ai'])
    const report = await exportToReport(page, request, notebookId)
    expect(report.blocks.map((block) => block.kind)).toEqual(['text', 'query'])
    expect(report.blocks[1]).toMatchObject({
      title: ANSWER.title,
      datasetId: space.datasetId,
    })
  })

  test('F: палитра «Хатлон» → паспорт → район → тетрадь с вопросом ИИ → доступ коллеге → отчёт', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const space = await runSpace(request, run, null)

    // Палитра команд: «Хатлон» находит область — открывается её паспорт
    await openWorkspace(page, request)
    await page.keyboard.press('Meta+k')
    const palette = page.getByPlaceholder(/Поиск объектов/)
    await expect(palette).toBeVisible()
    await palette.fill('Хатлон')
    await page.getByRole('option').filter({ hasText: 'Хатлонская область' }).first().click()
    await expect(page.getByRole('heading', { name: 'Хатлонская область' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByRole('region', { name: 'Показатели' })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Карта территории «Хатлонская область»' }),
    ).toBeVisible()

    // Переход в район: паспорт района с крошками до области
    await page.getByRole('tab', { name: /^Дочерние территории/ }).click()
    const children = page.getByRole('grid', { name: 'Дочерние территории' })
    const first = children.getByRole('row').nth(1)
    await expect(first).toBeVisible({ timeout: 20_000 })
    const district = ((await first.getByRole('gridcell').first().textContent()) ?? '').trim()
    expect(district).not.toBe('')
    await first.getByRole('gridcell').first().dblclick()
    await expect(page.getByRole('heading', { name: district })).toBeVisible()
    await expect(
      page.getByRole('navigation').getByRole('button', { name: 'Хатлонская область' }),
    ).toBeVisible()

    // Тетрадь района: вопрос данным на русском — график и запрос сохраняются в тетради
    const name = `Анализ: ${district} ${run}`
    const notebookId = await createNotebook(request, space, name)
    await page.goto(`/o/${notebookId}`)
    await expect(page.getByText('Все изменения сохранены')).toBeVisible({ timeout: 20_000 })
    await askInNotebook(page, space, 2, `Сколько обращений по районам — ${district}?`)
    await expect
      .poll(
        async () => {
          const record = await (await request.get(`/api/v1/notebooks/${notebookId}`)).json()
          return (record.cells as Array<{ kind: string; question?: string }>).at(-1)?.question
        },
        { timeout: 20_000 },
      )
      .toBe(`Сколько обращений по районам — ${district}?`)

    // Поделиться с коллегой: у него нет доступа к пространству — даём просмотр тетради
    const colleague = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    expect([403, 404]).toContain(
      (await colleague.request.get(`/api/v1/notebooks/${notebookId}`)).status(),
    )
    const colleagueUser = (await (await request.get('/api/v1/users?q=user001')).json())
      .items[0] as { displayName: string }
    await page.getByRole('button', { name: 'Поделиться' }).first().click()
    const share = page.getByRole('dialog', { name: `Доступ к «${name}»` })
    await share.getByPlaceholder('Имя, группа или подразделение').fill(colleagueUser.displayName)
    await share.getByRole('button', { name: colleagueUser.displayName }).first().click()
    await share.getByRole('button', { name: 'Добавить' }).click()
    await expect(page.getByText('Доступ предоставлен')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => (await colleague.request.get(`/api/v1/notebooks/${notebookId}`)).status())
      .toBe(200)
    await colleague.close()

    // В отчёт: ответ ИИ — блоком запроса отчёта
    const report = await exportToReport(page, request, notebookId)
    expect(report.blocks.map((block) => block.kind)).toEqual(['text', 'query'])
    expect(report.blocks[1]).toMatchObject({ title: ANSWER.title, datasetId: space.datasetId })
    await page.screenshot({ path: 'test-results/acceptance-p2-f-report.png' })
  })
})
