import { expect, openWorkspace, test } from './fixtures.js'

test.describe('Мобильный веб', () => {
  test('нижняя навигация вместо рейла', async ({ page, request }) => {
    await openWorkspace(page, request)

    const bottomNav = page.getByRole('navigation', { name: 'Основная навигация' })
    await expect(bottomNav).toBeVisible()
    await expect(bottomNav.getByText('Мой день')).toBeVisible()
    await expect(bottomNav.getByText('Входящие')).toBeVisible()
    await expect(bottomNav.getByText('Файлы')).toBeVisible()

    // Боковые панели скрыты
    await expect(page.getByRole('complementary', { name: 'Навигатор' })).toBeHidden()

    await bottomNav.getByText('Файлы').click()
    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()
  })
})
