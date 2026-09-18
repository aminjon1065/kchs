import type { Browser } from '@playwright/test'
import {
  EMPLOYEE_STATE,
  expect,
  openScreen,
  openWorkspace,
  resetWorkspaceState,
  test,
} from './fixtures.js'

const BASE = 'http://localhost:5173'

/** Сотрудник (user001) на «Мой день» с чистым рабочим пространством. */
async function employeeHome(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(context.request)
  await context.addInitScript(() => localStorage.removeItem('kchs.workspace'))
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  return { context, page }
}

/**
 * Консоль администрирования и «Мой день» (P0-E15): объявления от публикации до
 * снятия, матрица ролей с переходом к сотрудникам, назначение администратора
 * пространства, настройка виджетов с возвратом к набору по роли.
 */
test.describe('Консоль администрирования и «Мой день»', () => {
  test('объявление: администратор публикует, сотрудник видит в «Мой день», снятое исчезает', async ({
    page,
    request,
    browser,
  }) => {
    const title = `Учения ${Date.now().toString(36)}`
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Объявления' }).click()
    await page.getByRole('button', { name: 'Новое объявление' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Заголовок').fill(title)
    await dialog.getByLabel('Текст').fill('Эвакуация здания в пятницу в 10:00')
    await dialog.getByRole('radio', { name: 'Срочное' }).click()
    await dialog.getByRole('button', { name: 'Опубликовать' }).click()
    await expect(page.getByText('Объявление опубликовано')).toBeVisible()
    const row = page.getByRole('listitem').filter({ hasText: title })
    await expect(row.getByText('Показывается')).toBeVisible()

    // Сотрудник видит объявление на «Мой день»
    const { context: employee, page: employeePage } = await employeeHome(browser)
    await expect(employeePage.getByText(title)).toBeVisible({ timeout: 20_000 })

    // Снятие — с подтверждением; у сотрудника объявление пропадает
    await row.getByRole('button', { name: `Снять с показа: ${title}` }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Снять с показа' }).click()
    await expect(page.getByText('Объявление снято')).toBeVisible()
    await expect(row.getByText('Снято')).toBeVisible()
    await employeePage.reload()
    await expect(employeePage.getByRole('heading', { name: /Добр/ })).toBeVisible({
      timeout: 20_000,
    })
    await expect(employeePage.getByText(title)).toHaveCount(0)
    await employee.close()
  })

  test('матрица ролей ведёт к сотрудникам с ролью; администратор назначен пространству', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')

    await page.getByRole('tab', { name: 'Роли и способности' }).click()
    await expect(page.getByRole('rowheader', { name: /Администрирование системы/ })).toBeVisible()
    await page.getByRole('button', { name: 'Сотрудники с ролью «Администратор системы»' }).click()
    await expect(page.getByRole('tab', { name: 'Пользователи', selected: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Роль' })).toHaveText('Администратор системы')
    await expect(page.getByText('admin', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('user001')).toHaveCount(0)

    // Своё пространство прогона: права на общих пространствах демо-данных не меняются
    const spaceName = `Консоль ${Date.now().toString(36)}`
    const me = await request.get('/api/v1/me')
    const created = await request.post('/api/v1/spaces', {
      headers: { 'x-csrf-token': (await me.json()).session.csrfToken as string },
      data: { key: `console-${Date.now().toString(36)}`, name: spaceName },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    await page.getByRole('tab', { name: 'Пространства' }).click()
    await page.getByPlaceholder('Название или код').fill(spaceName)
    const space = page.getByRole('row').filter({ hasText: spaceName })
    await expect(space).toHaveCount(1)
    await space.getByRole('button', { name: /Назначить администратора/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('Имя, логин или почта').fill('user002')
    await dialog
      .getByRole('list', { name: 'Найденные сотрудники' })
      .getByRole('button')
      .first()
      .click()
    await dialog.getByRole('button', { name: 'Назначить' }).click()
    const toast = page.getByText(/ — администратор пространства$/)
    await expect(toast).toBeVisible()
    const assignee = (await toast.innerText()).replace(' — администратор пространства', '')
    await expect(space).toContainText(assignee)
  })

  test('«Мой день»: виджет скрыт и переставлен, настройка переживает перезагрузку и сбрасывается к роли', async ({
    browser,
  }) => {
    const { context, page } = await employeeHome(browser)
    // Заголовки виджетов — в основной области: у навигатора есть свой раздел «Недавние»
    const widget = (name: string) => page.getByRole('main').getByText(name, { exact: true })
    await expect(widget('Закреплённое')).toBeVisible({ timeout: 20_000 })

    await page.getByRole('button', { name: 'Настроить' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('checkbox', { name: 'Закреплённое' }).uncheck()
    await dialog.getByRole('button', { name: 'Выше: Недавние' }).click()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Настройки «Мой день» сохранены')).toBeVisible()
    await expect(widget('Закреплённое')).toHaveCount(0)

    await page.reload()
    await expect(widget('Недавние')).toBeVisible({ timeout: 20_000 })
    await expect(widget('Закреплённое')).toHaveCount(0)

    // Набор по роли возвращает всё как было
    await page.getByRole('button', { name: 'Настроить' }).click()
    await page.getByRole('button', { name: 'Набор по умолчанию для вашей роли' }).click()
    await expect(widget('Закреплённое')).toBeVisible()
    await context.close()
  })
})
