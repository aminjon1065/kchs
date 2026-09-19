import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Документооборот, ядро (P3-E02 S01, S03, S06, S07): регистрация входящего со
 * сканом — номер из журнала «Входящие», карточка с версией и PDF; служебная
 * записка — черновик из «Создать», правка карточки, регистрация действием
 * шага в контекст-панели. Негативные проверки грифа — интеграционные тесты
 * `apps/api/test/documents-grif.test.ts`.
 */
test.describe('Документы', () => {
  test('регистрация входящего: скан, карточка, номер журнала', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const subject = `О паводковой обстановке ${run}`

    // Скан письма — настоящий PDF со страницей текста
    const scanPage = await page.context().newPage()
    await scanPage.setContent(
      `<h1>Министерство финансов</h1><p>Исх. № 12-${run}</p><p>${subject}</p>`,
    )
    const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
    const scanPath = path.join(dir, `письмо-${run}.pdf`)
    await scanPage.pdf({ path: scanPath, format: 'A4' })
    await scanPage.close()

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await expect(page.getByRole('tab', { name: /Документы/ })).toBeVisible()
    await page.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const screen = page.getByRole('region', { name: 'Регистрация входящего' })
    await expect(screen).toBeVisible()

    // Скан — слева, в просмотрщике с масштабом
    await screen.locator('input[type="file"]').setInputFiles(scanPath)
    await expect(screen.getByRole('button', { name: 'Крупнее' })).toBeVisible({ timeout: 20_000 })

    // Карточка — справа: тема, корреспондент из справочника, исходящие реквизиты
    await screen.getByRole('textbox', { name: 'Тема' }).fill(subject)
    await screen.getByRole('searchbox', { name: 'Корреспондент' }).fill('Минфин')
    await screen
      .getByRole('list', { name: 'Корреспондент' })
      .getByRole('button', { name: /Министерство финансов/ })
      .click()
    await expect(screen.getByText('Министерство финансов Республики Таджикистан')).toBeVisible()
    await screen.getByRole('textbox', { name: 'Исходящий номер отправителя' }).fill(`12-${run}`)

    await screen.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const toast = page.getByText(/Зарегистрирован № ВХ-\d{4}\/\d{2}/)
    await expect(toast).toBeVisible({ timeout: 15_000 })
    const number = ((await toast.textContent()) ?? '').replace(/^.*№\s*/, '').trim()

    // Карточка открыта фоновой вкладкой: номер, статус, версия со сканом
    await page.getByRole('tab', { name: new RegExp(`${number}`) }).click()
    await expect(page.getByRole('heading', { name: subject })).toBeVisible()
    await expect(page.getByText(`№ ${number}`, { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Зарегистрирован', { exact: true }).first()).toBeVisible()
    await page.getByRole('tab', { name: /Файлы и версии/ }).click()
    await expect(page.getByText('Версия 1', { exact: true })).toBeVisible()
    await expect(page.getByText(/PDF готов/)).toBeVisible({ timeout: 30_000 })

    // В списке документов — строка с номером
    await page.getByRole('tab', { name: /^Документы/ }).click()
    await expect(page.getByRole('row', { name: new RegExp(number) })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('служебная записка: черновик, правка карточки, регистрация из контекст-панели', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const run = Date.now().toString(36)
    const subject = `О графике дежурств ${run}`

    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Новый документ' })
    await expect(dialog.getByRole('combobox', { name: 'Тип' })).toHaveText(/Служебная записка/)
    await dialog.getByRole('textbox', { name: 'Тема' }).fill(subject)
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click()

    // Карточка черновика: правка реквизитов и сохранение
    await expect(page.getByRole('heading', { name: subject })).toBeVisible()
    await expect(page.getByText('Черновик', { exact: true }).first()).toBeVisible()
    await page
      .getByRole('textbox', { name: 'Краткое содержание' })
      .fill('График на октябрь для дежурных смен')
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Карточка сохранена')).toBeVisible()

    // Действия шага — в контекст-панели: регистрация в журнале «Внутренние»
    const context = page.getByRole('complementary', { name: 'Контекст' })
    await context.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const register = page.getByRole('dialog', { name: 'Регистрация документа' })
    await expect(register.getByText(/Следующий номер: ВН-\d{4}\/\d{2}/)).toBeVisible()
    await register.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    await expect(page.getByText(/Зарегистрирован № ВН-\d{4}\/\d{2}/)).toBeVisible()
    await expect(page.getByText('Зарегистрирован', { exact: true }).first()).toBeVisible()
    await expect(
      context.getByRole('button', { name: 'Зарегистрировать', exact: true }),
    ).toHaveCount(0)
  })

  test('консоль: допуск сотрудника к грифам и режим администратора', async ({ page, request }) => {
    test.setTimeout(90_000)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const users = await request.get('/api/v1/users?q=user002')
    const employee = (
      (await users.json()).items as Array<{ id: string; login: string; displayName: string }>
    ).find((user) => user.login === 'user002')
    expect(employee).toBeTruthy()

    await openWorkspace(page, request)
    await page.goto('/admin')
    await page.getByRole('tab', { name: 'Пользователи' }).click()
    await page.getByPlaceholder('Имя, логин или почта').fill('user002')
    // Список перерисовывается после поиска — ждём отфильтрованную строку
    await expect(page.getByRole('row', { name: /user001/ })).toHaveCount(0)
    const row = page.getByRole('row', { name: /user002/ })
    await row.getByRole('button', { name: `Действия: ${employee?.displayName}` }).click()
    await page.getByRole('menuitem', { name: 'Допуск к грифам' }).click()
    const dialog = page.getByRole('dialog', { name: `Допуск: ${employee?.displayName}` })
    await dialog.getByRole('combobox', { name: 'Допуск' }).click()
    await page.getByRole('option', { name: 'Конфиденциально' }).click()
    await dialog.getByRole('textbox', { name: 'Основание' }).fill('Приказ о допуске № 15')
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Допуск изменён')).toBeVisible()
    await expect(row.getByText('Конфиденциально', { exact: true })).toBeVisible()

    // Режим администратора: обоснование, полоса в оболочке, выход
    await page.getByRole('tab', { name: 'Безопасность' }).click()
    await page.getByRole('button', { name: 'Войти в режим администратора' }).click()
    const enter = page.getByRole('dialog', { name: 'Войти в режим администратора' })
    await enter
      .getByRole('textbox', { name: 'Обоснование' })
      .fill('Проверка журнала по запросу № 7')
    await enter.getByRole('button', { name: 'Войти в режим', exact: true }).click()
    const banner = page.getByRole('status').filter({ hasText: 'Режим администратора до' })
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Выйти из режима' }).click()
    await expect(banner).toHaveCount(0)

    // Допуск — обратно по умолчанию: сценарии не зависят друг от друга
    const reset = await request.put(`/api/v1/users/${employee?.id}/clearance`, {
      headers,
      data: { clearance: 'internal', reason: 'Возврат после проверки e2e' },
    })
    expect(reset.ok(), await reset.text()).toBeTruthy()
  })
})
