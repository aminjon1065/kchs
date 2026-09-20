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

/**
 * Восстановление доступа (вопрос N83): письмо ведёт на `/reset-password?token=…`,
 * и этот адрес должен открывать экран смены пароля, а не оболочку. Проверяем,
 * что ссылка живая и что негодный токен честно об этом говорит.
 */
test.describe('Вход: восстановление доступа по ссылке', () => {
  test('ссылка из письма открывает смену пароля; негодный токен отклоняется', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto('/reset-password?token=' + 'a'.repeat(40))
    await expect(page.getByRole('heading', { name: /kchs|Комитет/ })).toBeVisible()
    await page.getByLabel('Новый пароль').fill('Novyj-Parol-2026!')
    await page.getByLabel('Повторите пароль').fill('Novyj-Parol-2026!')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
    await expect(page.getByText(/недействительна|истекла|Ссылка/)).toBeVisible({ timeout: 20_000 })
    await context.close()
  })
})
