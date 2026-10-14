import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Ручной обмен с закрытой госЭДО (ADR-0219). Входящие: выгрузка из госсистемы
 * загружается в очередь «Из госЭДО» — черновик входящего, регистрация обычной
 * карточкой, повтор того же файла не заводится. Исходящие: адресат с обменом через
 * госЭДО — после регистрации дело «Передать в госЭДО», пакет ZIP и отметка «передано»
 * с номером в госсистеме.
 */

const context = (page: Page) => page.getByRole('complementary', { name: 'Контекст' })

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), await me.text()).toBeTruthy()
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

test.describe('Документы: обмен с госЭДО', () => {
  test('выгрузка из госЭДО → черновик входящего → регистрация; повтор не заводится', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(240_000)
    const run = Date.now().toString(36)
    const fileName = `госэдо-${run}.pdf`

    // Выгрузка из госсистемы — настоящий PDF с реквизитами письма
    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const letterPath = path.join(dir, fileName)
    const scan = await (await browser.newContext()).newPage()
    await scan.setContent(
      `<h1>Министерство финансов</h1><p>Исх. № 31-${run} от 10.10.2026</p>` +
        `<p>О готовности районов к паводку ${run}</p><p>Просим сообщить о готовности.</p>`,
    )
    await scan.pdf({ path: letterPath, format: 'A4' })
    await scan.context().close()

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Из госЭДО', exact: true }).click()
    const screen = page.getByRole('region', { name: 'Из госЭДО' })
    await expect(screen).toBeVisible()

    // ── Загрузка: план, проверка повторов, черновик ─────────────────────────────
    await screen.getByRole('button', { name: 'Загрузить из госЭДО' }).first().click()
    const upload = page.getByRole('dialog', { name: 'Документы из госЭДО' })
    await upload.locator('input[type="file"]').setInputFiles(letterPath)
    await expect(
      upload.getByRole('list', { name: 'Что будет заведено' }).getByText(fileName),
    ).toBeVisible({ timeout: 20_000 })
    await upload.getByRole('button', { name: 'Завести 1 документ' }).click()
    await expect(page.getByText('Заведено документов: 1, повторов пропущено: 0')).toBeVisible({
      timeout: 30_000,
    })
    await expect(upload).toBeHidden()

    const item = screen.getByRole('listitem').filter({ hasText: fileName })
    await expect(item).toBeVisible({ timeout: 20_000 })
    await item.getByRole('button').click()
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/)
    await expect(page.getByText('Черновик', { exact: true }).first()).toBeVisible()

    // ── Регистрация — обычной карточкой ─────────────────────────────────────────
    await context(page)
      .getByRole('region', { name: 'Действия' })
      .getByRole('button', { name: 'Зарегистрировать', exact: true })
      .click()
    const register = page.getByRole('dialog', { name: 'Регистрация документа' })
    await register.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const registered = page.getByText(/Зарегистрирован № [\p{L}\d-]+\/\d+/u)
    await expect(registered).toBeVisible({ timeout: 15_000 })
    const number = ((await registered.textContent()) ?? '').replace(/^.*№\s*/, '').trim()

    // В очереди «Ждут регистрации» его больше нет, во «Все» — с номером
    await page.getByRole('tab', { name: /Из госЭДО/ }).click()
    await screen.getByRole('radio', { name: 'Все', exact: true }).click()
    await expect(screen.getByRole('listitem').filter({ hasText: fileName })).toContainText(
      `№ ${number}`,
      { timeout: 20_000 },
    )

    // ── Тот же файл ещё раз: узнан по содержимому и не заводится ────────────────
    await screen.getByRole('button', { name: 'Загрузить из госЭДО' }).first().click()
    await upload.locator('input[type="file"]').setInputFiles(letterPath)
    await expect(
      upload.getByText(`Уже заведён: ${number} — повторно не заводится`, { exact: true }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(upload.getByRole('button', { name: 'Завести', exact: true })).toBeDisabled()
    await upload.getByRole('button', { name: 'Отмена', exact: true }).click()
  })

  test('исходящий адресату с госЭДО: дело во Входящих, пакет и отметка о передаче', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const headers = await csrf(request)

    const correspondent = await request.post('/api/v1/correspondents', {
      headers,
      data: { kind: 'organization', name: `Министерство госЭДО ${run}`, edmsExchange: true },
    })
    expect(correspondent.ok(), await correspondent.text()).toBeTruthy()
    const types = (await (await request.get('/api/v1/document-types')).json()).items as Array<{
      id: string
      key: string
    }>
    const created = await request.post('/api/v1/documents', {
      headers,
      data: {
        typeId: types.find((type) => type.key === 'outgoing_letter')?.id,
        subject: `О передаче через госЭДО ${run}`,
        correspondentId: (await correspondent.json()).id,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const id = (await created.json()).id as string
    const doc = await (await request.get(`/api/v1/documents/${id}`)).json()

    // Основной файл версии — через сессию загрузки, как у клиента
    const pdf = `%PDF-1.4 исходящий для госЭДО ${run}\n`
    const session = await request.post('/api/v1/files/upload-sessions', {
      headers,
      data: {
        spaceId: doc.spaceId,
        name: `исходящий-${run}.pdf`,
        size: Buffer.byteLength(pdf),
        mime: 'application/pdf',
        attachToObjectId: id,
      },
    })
    expect(session.ok(), await session.text()).toBeTruthy()
    const upload = (await session.json()) as {
      uploadId: string
      storageKey: string
      singlePutUrl: string
      fileId: string
    }
    const put = await request.put(upload.singlePutUrl, {
      data: pdf,
      headers: { 'content-type': 'application/pdf' },
    })
    expect(put.ok(), await put.text()).toBeTruthy()
    const completed = await request.post(
      `/api/v1/files/upload-sessions/${upload.uploadId}/complete`,
      { headers, data: { uploadId: upload.uploadId, storageKey: upload.storageKey, parts: [] } },
    )
    expect(completed.ok(), await completed.text()).toBeTruthy()
    const version = await request.post(`/api/v1/documents/${id}/versions`, {
      headers,
      data: { mainFileId: upload.fileId },
    })
    expect(version.ok(), await version.text()).toBeTruthy()
    const registered = await request.post(`/api/v1/documents/${id}/register`, { headers, data: {} })
    expect(registered.ok(), await registered.text()).toBeTruthy()

    // Регистратору — дело «Передать в госЭДО» (подписчик регистрации, через outbox)
    await expect
      .poll(
        async () => {
          const inbox = await request.get('/api/v1/inbox?state=open')
          const items = (await inbox.json()).items as Array<{
            kind: string
            object: { id: string } | null
          }>
          return items.some((item) => item.kind === 'edms_transfer' && item.object?.id === id)
        },
        { timeout: 30_000 },
      )
      .toBe(true)

    await openWorkspace(page, request)
    await page.goto(`/o/${id}`)
    await page.getByRole('tab', { name: 'Карточка', exact: true }).click()
    const block = page.getByRole('tabpanel', { name: 'Карточка' }).getByRole('region', {
      name: 'госЭДО',
    })
    await expect(block.getByText('Ждёт передачи в госЭДО')).toBeVisible({ timeout: 20_000 })

    // Пакет для ручной загрузки в госсистему — ZIP с номером регистрации в имени
    const downloading = page.waitForEvent('download')
    await block.getByRole('button', { name: 'Скачать пакет для госЭДО' }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/\.zip$/)
    await expect(page.getByText(/Пакет готов: файлов \d+/)).toBeVisible()

    // Отметка о передаче с номером в госЭДО
    await block.getByRole('button', { name: 'Отметить: передано' }).click()
    const mark = page.getByRole('dialog', { name: 'Передано в госЭДО' })
    await mark.getByRole('textbox', { name: 'Номер в госЭДО' }).fill(`ГЭ-${run}`)
    await mark.getByRole('button', { name: 'Отметить: передано' }).click()
    await expect(page.getByText('Передача в госЭДО отмечена')).toBeVisible({ timeout: 15_000 })
    await expect(block.getByText(new RegExp(`№ ГЭ-${run}`))).toBeVisible()
    await expect(block.getByText('Ждёт передачи в госЭДО')).toBeHidden()

    // Дело во Входящих закрыто отметкой
    await expect
      .poll(
        async () => {
          const inbox = await request.get('/api/v1/inbox?state=open')
          const items = (await inbox.json()).items as Array<{
            kind: string
            object: { id: string } | null
          }>
          return items.some((item) => item.kind === 'edms_transfer' && item.object?.id === id)
        },
        { timeout: 30_000 },
      )
      .toBe(false)
  })
})
