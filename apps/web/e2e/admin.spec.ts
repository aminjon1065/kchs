import { expect, openScreen, openWorkspace, test } from './fixtures.js'

test.describe('Администрирование', () => {
  test('здоровье системы, пользователи, оргструктура и аудит', async ({ page, request }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Администрирование')

    // Здоровье
    await expect(page.getByText('postgres')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('meilisearch')).toBeVisible()
    await expect(page.getByText('storage')).toBeVisible()
    await expect(page.getByText('Работает').first()).toBeVisible()

    // Пользователи
    await page.getByRole('tab', { name: 'Пользователи' }).click()
    await expect(page.getByPlaceholder('Имя, логин или почта')).toBeVisible()
    await expect(page.getByText('admin', { exact: true }).first()).toBeVisible()

    // Оргструктура
    await page.getByRole('tab', { name: 'Оргструктура' }).click()
    await expect(page.getByText('Комитет', { exact: true }).first()).toBeVisible()

    // Аудит содержит записи входа
    await page.getByRole('tab', { name: 'Аудит' }).click()
    await expect(page.getByText('user.login').first()).toBeVisible({ timeout: 15_000 })

    // Выгрузка журнала в CSV — потоком с сервера
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Экспорт CSV' }).click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^kchs-audit-.+\.csv$/)
  })

  test('поиск находит объекты и фильтрует по типу', async ({ page, request }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Поиск')

    await page.getByPlaceholder('Что ищем?').fill('Регламенты')
    await expect(page.getByText(/результат/)).toBeVisible({ timeout: 15_000 })
  })
})
