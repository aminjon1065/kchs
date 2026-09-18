import { createServer, type Server } from 'node:http'
import { expect, openWorkspace, test } from './fixtures.js'

/** Порт поддельного провайдера ИИ: api поднят с AI_PROVIDER=openai-compat и этим адресом. */
const PORT = Number(process.env.KCHS_E2E_AI_PORT || 0)

/** Ответ «модели» — план ADR-0061: количество по районам, по убыванию, столбцы. */
const ANSWER = {
  answerable: true,
  reason: '',
  title: 'Происшествия по районам',
  explanation: 'Количество происшествий по районам, по убыванию',
  conditions: [],
  groups: [{ field: 'district', bucket: null }],
  measures: [{ agg: 'count', field: null }],
  sort: { by: 'count', dir: 'desc' },
  limit: null,
  chart: 'bar',
}

/**
 * Сценарий приёмки фазы 1 №7 (04-verification.md): «Спросить данные» — вопрос
 * на русском → график и показанный запрос → правка запроса вручную. Модель —
 * поддельный OpenAI-совместимый сервер этого теста: api должен быть запущен с
 * `AI_PROVIDER=openai-compat OPENAI_COMPAT_URL=http://127.0.0.1:<порт>/v1 AI_MODEL=kchs-e2e`,
 * а прогон — с `KCHS_E2E_AI_PORT=<порт>`; без этого сценарий пропускается.
 */
test.describe('Данные: «Спросить данные»', () => {
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

  test('вопрос → график и запрос → правка вручную', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Обращения ${run}`,
        spaceId: space?.id,
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
        rows: ['Бохтар', 'Бохтар', 'Бохтар', 'Худжанд', 'Худжанд', 'Хорог'].map(
          (district, index) => ({ values: { code: `A-${index}`, district, damage: index * 100 } }),
        ),
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()

    // Вопрос на русском — ответ графиком, понятый вопрос и запрос видны
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Спросить данные' }).click()
    await page
      .getByRole('textbox', { name: 'Вопрос к данным' })
      .fill('Сколько происшествий по районам?')
    await page.getByRole('button', { name: 'Спросить', exact: true }).click()
    await expect(page.getByText('Количество происшествий по районам, по убыванию')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByRole('combobox', { name: 'Разрезы' })).toHaveText('Район')
    expect(questions.at(-1)).toContain('Сколько происшествий по районам?')
    await page.getByRole('button', { name: 'Показать запрос' }).click()
    await expect(page.getByText(/"aggregate"/)).toBeVisible()
    await page.getByRole('radio', { name: 'Таблица' }).click()
    const result = page.getByRole('grid')
    await expect(result.getByRole('row').nth(1)).toContainText('Бохтар')

    // Правка вручную: мера «Сумма ущерба» вместо количества — результат перестроен
    await page.getByRole('combobox', { name: 'Меры' }).first().click()
    await page.getByRole('option', { name: 'Сумма' }).click()
    await expect(result.getByRole('columnheader', { name: 'Сумма: Ущерб' })).toBeVisible({
      timeout: 20_000,
    })
    // Худжанд: 300 + 400
    await expect(result.getByRole('gridcell', { name: /^700$/ })).toBeVisible()
  })
})
