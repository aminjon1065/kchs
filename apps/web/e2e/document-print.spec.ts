import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Печать и шаблоны документов (08-documents.md §5, §8; ADR-0085): входящее
 * регистрируется со сканом — движок ставит штамп регистрации на копию PDF, из
 * меню «Печать» строится регистрационная карточка; исходящее создаётся по
 * стартовому бланку — первая версия DOCX от движка и её PDF-представление.
 * Нужен движок со сборкой ADR-0085 (Chromium, pypdf, docxtpl, LibreOffice).
 */

interface RenderItem {
  kind: string
  form: string | null
  status: string
  file: { id: string; name: string } | null
}

async function csrf(request: APIRequestContext): Promise<string> {
  const me = await request.get('/api/v1/me')
  return (await me.json()).session.csrfToken as string
}

/** Корреспондент демо-сида; на стенде без него — заводится здесь. */
async function ensureMinistry(request: APIRequestContext): Promise<void> {
  const found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  if (((await found.json()).items ?? []).length > 0) return
  const created = await request.post('/api/v1/correspondents', {
    headers: { 'x-csrf-token': await csrf(request) },
    data: {
      name: 'Министерство финансов Республики Таджикистан',
      details: { shortName: 'Минфин' },
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
}

/** Печатные формы и заполнения документа — по API, для проверки содержимого. */
async function renders(request: APIRequestContext, documentId: string): Promise<RenderItem[]> {
  const response = await request.get(`/api/v1/documents/renders?subjectId=${documentId}`)
  return ((await response.json()).items ?? []) as RenderItem[]
}

test.describe('Печать и шаблоны документов', () => {
  test('входящее: штамп регистрации и регистрационная карточка в PDF', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const subject = `О подготовке к паводку ${run}`

    const scanPage = await page.context().newPage()
    await scanPage.setContent(
      `<h1>Министерство финансов</h1><p>Исх. № 7-${run}</p><p>${subject}</p>`,
    )
    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const scanPath = path.join(dir, `письмо-${run}.pdf`)
    await scanPage.pdf({ path: scanPath, format: 'A4' })
    await scanPage.close()
    await ensureMinistry(request)

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const screen = page.getByRole('region', { name: 'Регистрация входящего' })
    await screen.locator('input[type="file"]').setInputFiles(scanPath)
    await expect(screen.getByRole('button', { name: 'Крупнее' })).toBeVisible({ timeout: 20_000 })
    await screen.getByRole('textbox', { name: 'Тема' }).fill(subject)
    await screen.getByRole('searchbox', { name: 'Корреспондент' }).fill('Минфин')
    await screen
      .getByRole('list', { name: 'Корреспондент' })
      .getByRole('button', { name: /Министерство финансов/ })
      .click()
    await screen.getByRole('textbox', { name: 'Исходящий номер отправителя' }).fill(`7-${run}`)
    await screen.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const toast = page.getByText(/Зарегистрирован № [\p{L}\d-]+\/\d+/u)
    await expect(toast).toBeVisible({ timeout: 15_000 })
    const number = ((await toast.textContent()) ?? '').replace(/^.*№\s*/, '').trim()

    await page.getByRole('tab', { name: new RegExp(number) }).click()
    await expect(page.getByRole('heading', { name: subject })).toBeVisible()
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/)
    const documentId = new URL(page.url()).pathname.split('/').at(-1) ?? ''

    // Штамп ставится сам: движок накладывает его на копию PDF версии
    await page.getByRole('tab', { name: /Файлы и версии/ }).click()
    const printed = page.getByRole('region', { name: 'Печатные формы и шаблоны' })
    await expect(printed.getByText('PDF со штампом регистрации')).toBeVisible({ timeout: 90_000 })
    await expect(printed.getByRole('button', { name: 'Открыть' }).first()).toBeVisible({
      timeout: 90_000,
    })

    // Регистрационная карточка — из меню «Печать», готовый PDF открывается вкладкой
    await page.getByRole('button', { name: 'Печать', exact: true }).click()
    await page.getByRole('menuitem', { name: /Регистрационная карточка/ }).click()
    await expect(page.getByText('Готово: Регистрационная карточка')).toBeVisible({
      timeout: 90_000,
    })
    const cardTab = page.getByRole('tab', { name: /Регистрационно-контрольная карточка/ })
    await expect(cardTab).toBeVisible()
    await expect(cardTab).toHaveAttribute('aria-selected', 'true')

    // Файлы — настоящие PDF, прикреплённые к документу
    const items = documentId ? await renders(request, documentId) : []
    const card = items.find((item) => item.form === 'registration_card')
    const stamp = items.find((item) => item.form === 'registration_stamp')
    expect(card?.status).toBe('ready')
    expect(stamp?.status).toBe('ready')
    for (const item of [card, stamp]) {
      const link = await request.get(`/api/v1/files/${item?.file?.id}/download`)
      expect(link.ok(), await link.text()).toBeTruthy()
      const pdf = await request.get((await link.json()).url as string)
      expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
    }
  })

  test('исходящее по бланку: первая версия — DOCX от движка, затем PDF', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const subject = `О предоставлении сведений о паводке ${run}`

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Новый документ' })
    await dialog.getByRole('combobox', { name: 'Тип' }).click()
    await page.getByRole('option', { name: 'Исходящее письмо' }).click()
    await dialog.getByRole('combobox', { name: 'Шаблон' }).click()
    await page.getByRole('option', { name: 'Исходящее письмо — бланк' }).click()
    await dialog.getByRole('textbox', { name: 'Тема' }).fill(subject)
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click()

    await expect(page.getByRole('heading', { name: subject })).toBeVisible()
    await page.getByRole('tab', { name: /Файлы и версии/ }).click()
    await expect(page.getByText('Версия 1', { exact: true })).toBeVisible({ timeout: 90_000 })
    // Примечание версии и строка заполнения в «Печатных формах и шаблонах»
    await expect(page.getByText('По шаблону «Исходящее письмо — бланк»').first()).toBeVisible()
    await expect(page.getByText(/PDF готов/)).toBeVisible({ timeout: 120_000 })

    // Текст первой версии — из шаблона с темой документа
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/)
    const documentId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
    const card = await (await request.get(`/api/v1/documents/${documentId}`)).json()
    expect(card.currentVersion.mainFile.name).toBe(`${subject}.docx`)
    await expect
      .poll(
        async () => {
          const text = await request.get(`/api/v1/files/${card.currentVersion.mainFile.id}/text`)
          return ((await text.json()).text ?? '') as string
        },
        { timeout: 90_000 },
      )
      .toContain(subject)
  })
})
