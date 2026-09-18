import { expect, openWorkspace, test } from './fixtures.js'

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
    await page.keyboard.press('Meta+k')
    await page.getByPlaceholder(/Поиск объектов/).fill('Файлы')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')

    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()
    await expect(page.getByText('Общее').first()).toBeVisible()
  })
})
