import { expect, openScreen, openWorkspace, test } from './fixtures.js'

const LINK_PASSWORD = 'guest-link-2026'

/**
 * Сценарий приёмки 4 (04-verification.md §3): владелец делится объектом
 * по ссылке с паролем, гость открывает её без входа в систему.
 */
test.describe('Гостевая ссылка', () => {
  test('объект открывается по ссылке с паролем и без входа', async ({ page, request }) => {
    const me = await request.get('/api/v1/me')
    const csrfToken = (await me.json()).session.csrfToken as string
    const headers = { 'x-csrf-token': csrfToken }

    const spaces = await request.get('/api/v1/spaces')
    const spaceId = (await spaces.json()).items.find(
      (space: { kind: string }) => space.kind !== 'personal',
    ).id

    const title = `Регламент ${Date.now().toString(36)}`
    const folder = await request.post('/api/v1/folders', {
      headers,
      data: { name: title, spaceId },
    })
    expect(folder.ok()).toBeTruthy()
    const folderId = (await folder.json()).id

    const link = await request.post(`/api/v1/objects/${folderId}/share-links`, {
      headers,
      data: { level: 'view', password: LINK_PASSWORD, includeAttachments: true },
    })
    expect(link.ok()).toBeTruthy()
    const token = (await link.json()).token as string

    // Гость: отдельный контекст без сессии
    const guest = await page
      .context()
      .browser()
      ?.newContext({ baseURL: 'http://localhost:5173', storageState: undefined })
    if (!guest) throw new Error('не удалось создать гостевой контекст')
    const guestPage = await guest.newPage()

    await guestPage.goto(`/s/${token}`)
    await expect(guestPage.getByText('Ссылка защищена паролем')).toBeVisible()

    await guestPage.getByLabel('Пароль ссылки').fill(LINK_PASSWORD)
    await guestPage.getByRole('button', { name: 'Открыть' }).click()

    await expect(guestPage.getByRole('heading', { name: title })).toBeVisible()
    await expect(guestPage.getByText('Только просмотр')).toBeVisible()
    await guestPage.screenshot({ path: 'test-results/share-link-guest.png', fullPage: false })

    // Рабочее пространство гостю недоступно
    await guestPage.goto('/')
    await expect(guestPage.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()

    await guest.close()
  })

  test('владелец создаёт ссылку в диалоге «Поделиться» и отзывает её', async ({
    page,
    request,
    browser,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Файлы')
    const name = `Ссылка из диалога ${Date.now().toString(36)}`
    await page.getByRole('button', { name: 'Новая папка' }).click()
    await page.getByLabel('Имя папки').fill(name)
    await page.getByRole('button', { name: 'Создать' }).click()
    const row = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name }) })
    await row.hover()
    await row.getByRole('button', { name: 'Поделиться' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Создать ссылку' }).click()
    await dialog.getByLabel('Пароль', { exact: true }).fill(LINK_PASSWORD)
    await dialog.getByRole('button', { name: 'Создать ссылку' }).click()
    // Адрес показывается один раз: токен хранится только хешем
    const address = dialog.getByLabel('Адрес гостевой ссылки')
    await expect(address).toBeVisible()
    const url = new URL(await address.inputValue())
    await expect(dialog.getByText('с паролем · бессрочно · открытий: 0')).toBeVisible()

    const guest = await browser.newContext({
      baseURL: 'http://localhost:5173',
      storageState: undefined,
    })
    const guestPage = await guest.newPage()
    await guestPage.goto(url.pathname)
    await guestPage.getByLabel('Пароль ссылки').fill(LINK_PASSWORD)
    await guestPage.getByRole('button', { name: 'Открыть' }).click()
    await expect(guestPage.getByRole('heading', { name })).toBeVisible()

    // Отзыв закрывает ссылку и для уже открывшего её гостя
    await dialog.getByRole('button', { name: 'Отозвать' }).click()
    await expect(dialog.getByRole('button', { name: 'Отозвать' })).toHaveCount(0)
    await guestPage.reload()
    await expect(guestPage.getByText('Ссылка недействительна, отозвана или истекла')).toBeVisible()
    await guest.close()
  })

  test('неверный пароль не открывает объект', async ({ page, request }) => {
    const me = await request.get('/api/v1/me')
    const csrfToken = (await me.json()).session.csrfToken as string
    const headers = { 'x-csrf-token': csrfToken }

    const spaces = await request.get('/api/v1/spaces')
    const spaceId = (await spaces.json()).items.find(
      (space: { kind: string }) => space.kind !== 'personal',
    ).id

    const folder = await request.post('/api/v1/folders', {
      headers,
      data: { name: `Закрытая ${Date.now().toString(36)}`, spaceId },
    })
    const folderId = (await folder.json()).id
    const link = await request.post(`/api/v1/objects/${folderId}/share-links`, {
      headers,
      data: { level: 'view', password: LINK_PASSWORD, includeAttachments: false },
    })
    const token = (await link.json()).token as string

    const guest = await page
      .context()
      .browser()
      ?.newContext({ baseURL: 'http://localhost:5173', storageState: undefined })
    if (!guest) throw new Error('не удалось создать гостевой контекст')
    const guestPage = await guest.newPage()

    await guestPage.goto(`/s/${token}`)
    await guestPage.getByLabel('Пароль ссылки').fill('не тот пароль')
    await guestPage.getByRole('button', { name: 'Открыть' }).click()

    await expect(guestPage.getByText('Неверный пароль ссылки')).toBeVisible()
    await guest.close()
  })
})
