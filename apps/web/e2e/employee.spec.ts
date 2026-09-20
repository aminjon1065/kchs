import { expect, openScreen, openWorkspace, test } from './fixtures.js'

test.use({ storageState: './e2e/.auth/employee.json' })

test.describe('Права рядового сотрудника', () => {
  test('нет доступа к администрированию', async ({ page, request }) => {
    await openWorkspace(page, request)

    // Способности admin.system нет — команда не предлагается в палитре
    await page.keyboard.press('Meta+k')
    await page.getByPlaceholder(/Поиск объектов/).fill('Администрирование')
    await expect(page.getByText('Ничего не найдено')).toBeVisible()
    await page.keyboard.press('Escape')

    // И рейл не показывает раздел администрирования
    await expect(page.getByRole('button', { name: 'Администрирование' })).toHaveCount(0)
  })

  test('видит общее пространство и свои файлы', async ({ page, request }) => {
    await openWorkspace(page, request)
    // Первый результат палитры на общем стенде — не обязательно экран: берём
    // пункт по названию (`openScreen`)
    await openScreen(page, 'Файлы')

    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()
    await expect(page.getByText('Общее').first()).toBeVisible()
  })
})
