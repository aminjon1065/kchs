import { expect, test } from './fixtures.js'

/**
 * Временный пароль от администратора (17-security.md §2): сотрудник входит,
 * видит только экран смены пароля и попадает в рабочее пространство после неё.
 */
test.describe('Временный пароль', () => {
  test('вход по временному паролю требует задать свой', async ({ page, request, browser }) => {
    const me = await request.get('/api/v1/me')
    const csrf = (await me.json()).session.csrfToken as string
    const login = `temp_${Date.now().toString(36)}`

    const created = await request.post('/api/v1/users', {
      headers: { 'x-csrf-token': csrf },
      data: { login, lastName: 'Временный', firstName: 'Сотрудник' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const { temporaryPassword } = await created.json()

    // Новый сотрудник — в чистом браузере, без сессии администратора
    const context = await browser.newContext({ storageState: undefined })
    const guest = await context.newPage()
    await guest.goto(page.url() === 'about:blank' ? '/' : page.url())
    await guest.getByLabel('Логин или почта').fill(login)
    await guest.getByLabel('Пароль', { exact: true }).fill(temporaryPassword)
    await guest.getByRole('button', { name: 'Войти', exact: true }).click()

    await expect(guest.getByRole('heading', { name: 'Задайте свой пароль' })).toBeVisible()
    // Оболочки нет, пока пароль временный
    await expect(guest.getByRole('tab', { name: /Мой день/ })).toHaveCount(0)

    await guest.getByLabel('Временный пароль').fill(temporaryPassword)
    await guest.getByLabel('Новый пароль', { exact: true }).fill('Permanent!Pass-2026')
    await guest.getByLabel('Повторите новый пароль').fill('Permanent!Pass-2026')
    await guest.getByRole('button', { name: 'Сменить пароль' }).click()

    await expect(guest.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
    await context.close()
  })
})
