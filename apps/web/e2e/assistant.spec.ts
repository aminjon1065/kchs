import { createServer, type Server } from 'node:http'
import { expect, openWorkspace, test } from './fixtures.js'

/** Порт поддельного провайдера ИИ: api поднят с AI_PROVIDER=openai-compat и этим адресом. */
const PORT = Number(process.env.KCHS_E2E_AI_PORT || 0)

/**
 * Ассистент в контекстной панели (P5-E05, ADR-0100): диалог по открытому
 * объекту, шаги с инструментами, ссылки на найденное и предложение поручения,
 * которое создаёт человек. Модель — поддельный OpenAI-совместимый сервер: api
 * запущен с `AI_PROVIDER=openai-compat OPENAI_COMPAT_URL=http://127.0.0.1:<порт>/v1
 * AI_MODEL=kchs-e2e`, прогон — с `KCHS_E2E_AI_PORT=<порт>`; иначе пропускается.
 */
test.describe('Ассистент', () => {
  test.skip(!PORT, 'api без поддельного провайдера ИИ — задайте KCHS_E2E_AI_PORT (см. описание)')
  const run = Date.now().toString(36)
  const title = `Паводок в Хатлоне ${run}`
  let server: Server
  /** Очередь ответов «модели»: сначала шаг поиска, потом ответ. */
  let answers: unknown[] = []

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      // Тело запроса вычитывается: без этого соединение не закрывается
      request.on('data', () => undefined)
      request.on('end', () => {
        const answer = answers.shift() ?? {
          action: 'answer',
          text: 'Нечего добавить.',
          citations: [],
          proposals: [],
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: 'chatcmpl_assistant',
            object: 'chat.completion',
            model: 'kchs-e2e',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(answer) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
          }),
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve))
  })

  test.afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve))
  })

  test('вопрос по объекту: шаг поиска, ссылка на найденное и поручение предложением', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await openWorkspace(page, request)

    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    // Проект заводится в первом доступном пространстве стенда
    const spaces = await request.get('/api/v1/spaces')
    expect(spaces.ok(), await spaces.text()).toBeTruthy()
    const spaceId = ((await spaces.json()).items as Array<{ id: string }>)[0]?.id
    expect(spaceId, 'на стенде есть пространство').toBeTruthy()

    const project = await request.post('/api/v1/projects', {
      headers,
      data: {
        key: `AST${run.toUpperCase().slice(-5)}`,
        name: title,
        description: 'Подтоплены дороги, нужен насос и мешки с песком для берега реки Вахш.',
        spaceId,
      },
    })
    expect(project.ok(), await project.text()).toBeTruthy()
    const projectId = (await project.json()).id as string

    // Индекс наполняет воркер: ждём, пока проект начнёт находиться
    await expect
      .poll(
        async () => {
          const found = await request.get(
            `/api/v1/search?q=${encodeURIComponent(title)}&mode=words`,
          )
          const hits = ((await found.json()).hits ?? []) as Array<{ objectId: string }>
          return hits.some((hit) => hit.objectId === projectId)
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    answers = [
      { action: 'tool', tool: 'search', query: title, objectId: '', reason: 'ищу по названию' },
      {
        action: 'answer',
        text: `По паводку есть проект «${title}».`,
        citations: [projectId],
        proposals: [
          {
            kind: 'task',
            title: `Проверить насосы ${run}`,
            description: 'По итогам разговора с ассистентом',
            sourceId: null,
          },
        ],
      },
    ]

    await page.goto(`/o/${projectId}`)
    const panel = page.getByRole('complementary', { name: 'Контекст' })
    await panel.getByRole('button', { name: 'Ассистент' }).click()
    await expect(panel.getByLabel('Вопрос ассистенту')).toBeVisible({ timeout: 20_000 })

    await panel.getByLabel('Вопрос ассистенту').fill('Что известно по этому паводку?')
    await panel.getByRole('button', { name: 'Спросить' }).click()

    // Ответ со ссылкой на найденный объект и видимым шагом поиска
    await expect(panel.getByText(`По паводку есть проект «${title}».`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(panel.getByRole('list', { name: 'Что делал ассистент' })).toContainText(
      'ищу по названию',
    )
    await expect(panel.getByRole('list', { name: 'Ссылки ответа' })).toContainText(title)

    // Поручение — предложение: создаёт его человек в обычном диалоге
    await panel.getByRole('button', { name: 'Создать поручение' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новое поручение' })
    await expect(dialog.getByLabel('Название*')).toHaveValue(`Проверить насосы ${run}`)
    await dialog.getByRole('searchbox', { name: 'Исполнитель' }).fill('user001')
    await dialog.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    await dialog.getByLabel('Срок*').fill(due)
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 20_000 })
  })
})
