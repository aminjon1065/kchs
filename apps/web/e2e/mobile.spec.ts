import { expect, openWorkspace, test } from './fixtures.js'

test.describe('Мобильный веб', () => {
  test('нижняя навигация вместо рейла', async ({ page, request }) => {
    await openWorkspace(page, request)

    const bottomNav = page.getByRole('navigation', { name: 'Основная навигация' })
    await expect(bottomNav).toBeVisible()
    await expect(bottomNav.getByText('Мой день')).toBeVisible()
    await expect(bottomNav.getByText('Входящие')).toBeVisible()
    await expect(bottomNav.getByText('Чаты')).toBeVisible()

    // Боковые панели скрыты
    await expect(page.getByRole('complementary', { name: 'Навигатор' })).toBeHidden()

    // Файлы — в «Ещё»: на узком экране в навигации только пять кнопок
    await bottomNav.getByText('Ещё').click()
    await page.getByRole('menuitem', { name: 'Файлы' }).click()
    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()
  })
})
