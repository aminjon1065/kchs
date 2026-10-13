import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Донесение без сети (ADR-0212): сотрудник открывает «Донесение» при связи (тип и
 * районы запоминаются на устройстве), связь пропадает — он заполняет реквизиты ЧС,
 * фотографирует и отправляет; донесение ждёт в очереди устройства. Связь вернулась —
 * черновик создаётся на сервере тем же ключом, снимок прикреплён к документу.
 * Нужен тип «Донесение» с реквизитами ЧС — его ставит пакет ЧС.
 */

/** PNG 1×1: устройство пережмёт его в JPEG, как снимок камеры. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test.describe('Донесение без сети', () => {
  test('связь пропала: донесение с фото ждёт на устройстве и уходит само', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const subject = `Подмыт устой моста ${run}`

    await openWorkspace(page, request)
    await openScreen(page, 'Документы')
    await page.getByRole('button', { name: 'Донесение', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Новое донесение' })
    await expect(dialog.getByRole('button', { name: 'Отправить' })).toBeVisible()
    // Районы — пока есть связь: справочник ложится на устройство
    await dialog.getByRole('button', { name: /^Район/ }).click()
    await page.getByLabel('Найти территорию').fill('а')
    await page.getByRole('list', { name: 'Результаты поиска' }).getByRole('button').first().click()

    await page.context().setOffline(true)
    await dialog.getByLabel('Кратко о происшествии').fill(subject)
    await dialog.getByRole('combobox', { name: /Вид ЧС/ }).click()
    await page.getByRole('option').first().click()
    await dialog.getByLabel(/Время возникновения/).fill('2026-10-13T08:30')
    await dialog.getByLabel('Добавить фото', { exact: true }).setInputFiles({
      name: 'мост.png',
      mimeType: 'image/png',
      buffer: PIXEL,
    })
    // Снимок на устройстве: миниатюра из IndexedDB, без сервера
    await expect(dialog.getByRole('img', { name: 'Фото донесения' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Отправить' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(`Донесение «${subject}» ждёт отправки`)).toBeVisible()

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/documents' &&
        response.ok(),
      { timeout: 60_000 },
    )
    await page.context().setOffline(false)
    const { id } = (await (await created).json()) as { id: string }
    await expect(page.getByText('Донесение из очереди отправлено')).toBeVisible({
      timeout: 45_000,
    })
    await expect(page.getByText(`Донесение «${subject}» ждёт отправки`)).toBeHidden()

    // На сервере — черновик «Донесения» с реквизитами и снимком, прикреплённым к нему
    const card = await request.get(`/api/v1/documents/${id}`)
    expect(card.ok(), await card.text()).toBeTruthy()
    expect(await card.json()).toMatchObject({ subject, status: 'draft' })
    const links = await (await request.get(`/api/v1/objects/${id}/links`)).json()
    expect(
      (links.links as Array<{ kind: string }>).some((link) => link.kind === 'attachment'),
    ).toBe(true)
  })
})
