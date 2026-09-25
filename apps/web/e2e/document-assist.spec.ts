import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, openWorkspace, test } from './fixtures.js'

/** Порт поддельного провайдера ИИ: api поднят с AI_PROVIDER=openai-compat и этим адресом. */
const PORT = Number(process.env.KCHS_E2E_AI_PORT || 0)

/**
 * ИИ в документах (P3-E02 S02, P3-E05 S01, ADR-0088): регистрация входящего
 * по скану — модель предлагает реквизиты с уверенностью, делопроизводитель
 * принимает их сам; в карточке — ассистент: краткое содержание в карточку и
 * черновик ответа. Модель — поддельный OpenAI-совместимый сервер этого теста:
 * api запущен с `AI_PROVIDER=openai-compat OPENAI_COMPAT_URL=http://127.0.0.1:<порт>/v1
 * AI_MODEL=kchs-e2e`, прогон — с `KCHS_E2E_AI_PORT=<порт>`; иначе сценарий пропускается.
 */
test.describe('ИИ в документах', () => {
  test.skip(!PORT, 'api без поддельного провайдера ИИ — задайте KCHS_E2E_AI_PORT (см. описание)')
  const run = Date.now().toString(36)
  const subject = `О паводковой обстановке ${run}`
  const summary = `Минфин сообщает о паводковой обстановке и просит данные до 1 октября ${run}.`
  const prompts: Record<string, string[]> = {}
  let server: Server

  /** Ответ «модели» по имени схемы запроса. */
  const answers: Record<string, unknown> = {
    document_requisites: {
      items: [
        { key: 'subject', value: subject, confidence: 0.93, quote: subject },
        { key: 'externalNumber', value: `12-${run}`, confidence: 0.97, quote: `Исх. № 12-${run}` },
        { key: 'externalDate', value: '2026-09-15', confidence: 0.6, quote: 'от 15.09.2026' },
      ],
      sender: {
        name: 'Министерство финансов Республики Таджикистан',
        confidence: 0.9,
        quote: 'Министерство финансов',
      },
    },
    document_kind: { key: 'incoming_letter', confidence: 0.88, quote: 'Министерство финансов' },
    document_summary: { summary },
    document_reply: {
      subject: `О паводковой обстановке — ответ ${run}`,
      body: 'Сообщаем, что данные районов будут направлены до 1 октября 2026 года.',
    },
  }

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {
          messages?: Array<{ content?: unknown }>
          response_format?: { json_schema?: { name?: string } }
        }
        const schema = parsed.response_format?.json_schema?.name ?? ''
        prompts[schema] = [...(prompts[schema] ?? []), JSON.stringify(parsed.messages ?? [])]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            id: `chatcmpl_${schema}`,
            object: 'chat.completion',
            model: 'kchs-e2e',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: JSON.stringify(answers[schema] ?? {}) },
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

  test('скан → предложения ИИ → принять → регистрация; ассистент: резюме и черновик ответа', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    // Скан письма — PDF с текстовым слоем: движок извлекает текст без OCR
    const scanPage = await page.context().newPage()
    await scanPage.setContent(
      `<h1>Министерство финансов Республики Таджикистан</h1><p>Исх. № 12-${run} от 15.09.2026</p><p>${subject}</p>`,
    )
    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const scanPath = path.join(dir, `письмо-${run}.pdf`)
    await scanPage.pdf({ path: scanPath, format: 'A4' })
    await scanPage.close()

    // Корреспондент — из демо-сида; на стенде без него заводится здесь
    const found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
    if (((await found.json()).items ?? []).length === 0) {
      const me = await request.get('/api/v1/me')
      const created = await request.post('/api/v1/correspondents', {
        headers: { 'x-csrf-token': (await me.json()).session.csrfToken as string },
        data: {
          name: 'Министерство финансов Республики Таджикистан',
          details: { shortName: 'Минфин' },
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
    }

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const screen = page.getByRole('region', { name: 'Регистрация входящего' })
    await screen.locator('input[type="file"]').setInputFiles(scanPath)

    // Текст скана извлечён — помощник предлагает заполнить карточку
    const fill = screen.getByRole('button', { name: 'Заполнить по скану' })
    await expect(fill).toBeVisible({ timeout: 60_000 })

    // Вид документа по скану (ADR-0126): предложение с уверенностью; в демо-наборе
    // мастер и так открыт на «Входящем письме» — помощник это подтверждает
    await screen.getByRole('button', { name: 'Определить вид' }).click()
    await expect(screen.getByText('уверенно · 88%')).toBeVisible({ timeout: 20_000 })
    await expect(screen.getByText('Этот вид уже выбран')).toBeVisible()
    await fill.click()
    const suggestions = screen.getByRole('list', { name: 'Предложения ИИ' })
    await expect(suggestions).toContainText(subject)
    await expect(suggestions).toContainText('Найден в справочнике корреспондентов')
    await expect(suggestions).toContainText('проверьте · 60%')
    // Текст скана ушёл модели
    expect(prompts.document_requisites?.[0]).toContain(`12-${run}`)

    // Ничего не заполнено без подтверждения; «принять уверенные» — тема и номер
    await expect(screen.getByRole('textbox', { name: 'Тема' })).toHaveValue('')
    await screen.getByRole('button', { name: 'Принять уверенные (2)' }).click()
    await expect(screen.getByRole('textbox', { name: 'Тема' })).toHaveValue(subject)
    await expect(screen.getByRole('textbox', { name: 'Исходящий номер отправителя' })).toHaveValue(
      `12-${run}`,
    )
    await screen.getByRole('button', { name: 'Принять: Корреспондент' }).click()
    await expect(
      screen.getByText('Министерство финансов Республики Таджикистан').first(),
    ).toBeVisible()

    await screen.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const toast = page.getByText(/Зарегистрирован № [\p{L}\d-]+\/\d+/u)
    await expect(toast).toBeVisible({ timeout: 15_000 })
    const number = ((await toast.textContent()) ?? '').replace(/^.*№\s*/, '').trim()
    await page.getByRole('tab', { name: new RegExp(`${number}`) }).click()
    await expect(page.getByRole('heading', { name: subject })).toBeVisible()

    // Ассистент документа: краткое содержание — в карточку
    const panel = page.getByRole('complementary', { name: 'Контекст' })
    await panel.getByRole('button', { name: 'Ассистент' }).click()
    await panel.getByRole('button', { name: 'Составить' }).click()
    await expect(panel.getByText(summary)).toBeVisible()
    await panel.getByRole('button', { name: 'Вставить в карточку' }).click()
    await expect(page.getByText('Краткое содержание вставлено в карточку')).toBeVisible()

    // Черновик ответа по указаниям исполнителя
    await panel.getByLabel('Что ответить').fill('данные районов направим до 1 октября')
    await panel.getByRole('button', { name: 'Подготовить черновик' }).click()
    const draft = panel.getByRole('article', { name: 'Черновик ответа' })
    await expect(draft).toContainText(`ответ ${run}`)
    expect(prompts.document_reply?.[0]).toContain('данные районов направим до 1 октября')
  })
})
