import type { Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Исходящий письмом из ящика канцелярии (ADR-0149): зарегистрированный исходящий уходит
 * адресату письмом с PDF версии, в карточке — блок «Письма» со статусом, отметка отправки
 * ставится после приёма сервером. SMTP стенда — mailpit (`MAILPIT_URL`).
 */

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025'
const context = (page: Page) => page.getByRole('complementary', { name: 'Контекст' })

test.describe('Документы: исходящий письмом', () => {
  test('письмо с PDF уходит адресату, статус и отметка отправки в карточке', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const address = `ministry-${run}@example.tj`
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }

    const correspondent = await request.post('/api/v1/correspondents', {
      headers,
      data: {
        kind: 'organization',
        name: `Министерство проверки ${run}`,
        contacts: { email: address },
      },
    })
    expect(correspondent.ok(), await correspondent.text()).toBeTruthy()
    const types = (await (await request.get('/api/v1/document-types')).json()).items as Array<{
      id: string
      key: string
    }>
    const outgoing = types.find((type) => type.key === 'outgoing_letter')
    const created = await request.post('/api/v1/documents', {
      headers,
      data: {
        typeId: outgoing?.id,
        subject: `О проверке почты ${run}`,
        correspondentId: (await correspondent.json()).id,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const id = (await created.json()).id as string
    const doc = await (await request.get(`/api/v1/documents/${id}`)).json()
    const pdf = `%PDF-1.4 письмо проверки ${run}\n`
    const uploading = await request.post('/api/v1/files/upload-sessions', {
      headers,
      data: {
        spaceId: doc.spaceId,
        name: `письмо-${run}.pdf`,
        size: Buffer.byteLength(pdf),
        mime: 'application/pdf',
        attachToObjectId: id,
      },
    })
    expect(uploading.ok(), await uploading.text()).toBeTruthy()
    const upload = (await uploading.json()) as {
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
    const fileId = upload.fileId
    const version = await request.post(`/api/v1/documents/${id}/versions`, {
      headers,
      data: { mainFileId: fileId },
    })
    expect(version.ok(), await version.text()).toBeTruthy()
    const registered = await request.post(`/api/v1/documents/${id}/register`, { headers, data: {} })
    expect(registered.ok(), await registered.text()).toBeTruthy()

    await openWorkspace(page, request)
    await page.goto(`/o/${id}`)
    await context(page)
      .getByRole('region', { name: 'Делопроизводство' })
      .getByRole('button', { name: 'Отметить отправку', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Отметка об отправке' })
    await dialog.getByRole('combobox', { name: 'Способ доставки' }).click()
    await page.getByRole('option', { name: 'Электронная почта' }).click()
    await expect(dialog.getByText(/Письмо уйдёт от/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Отправить письмом' }).click()
    await expect(page.getByText('Письмо поставлено в очередь отправки')).toBeVisible({
      timeout: 20_000,
    })

    // Письмо дошло до SMTP стенда с PDF во вложении
    await expect
      .poll(
        async () => {
          const found = await request.get(
            `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
          )
          if (!found.ok()) return 0
          const body = (await found.json()) as { messages?: Array<{ Attachments?: number }> }
          return body.messages?.[0]?.Attachments ?? 0
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0)

    // В карточке — «Отправлено» в блоке «Письма» и отметка отправки
    await page.reload()
    await expect(page.getByText('Отправлено', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    })
  })
})
