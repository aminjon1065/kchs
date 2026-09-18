import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Именованные рабочие пространства (P0-E14 S06): текущие вкладки сохраняются
 * под именем и открываются одним действием — из меню или палитры команд.
 */
test.describe('Именованные рабочие пространства', () => {
  test('сохранить вкладки, открыть, вернуть прежние, открыть из палитры', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    const name = `Штаб паводка ${Date.now().toString(36)}`

    await openScreen(page, 'Файлы')
    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()

    // Сохранить набор вкладок
    await page.getByRole('button', { name: 'Рабочие пространства' }).click()
    await page.getByRole('menuitem', { name: 'Сохранить вкладки как…' }).click()
    await page.getByLabel('Название').fill(name)
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText(`Рабочее пространство «${name}» сохранено`)).toBeVisible()

    // Закрыть «Файлы» — остаётся только «Мой день»
    const filesTab = page.getByRole('tab', { name: /Файлы/ })
    await filesTab.hover()
    await filesTab.getByRole('button', { name: 'Закрыть вкладку' }).click()
    await expect(page.getByRole('tab', { name: /Файлы/ })).toHaveCount(0)

    // Открыть из меню — вкладки возвращаются, «Вернуть» отменяет
    await page.getByRole('button', { name: 'Рабочие пространства' }).click()
    await page.getByRole('menuitem', { name: new RegExp(name) }).hover()
    await page.getByRole('menuitem', { name: 'Открыть', exact: true }).click()
    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()
    await page.getByRole('button', { name: 'Вернуть прежние вкладки' }).click()
    await expect(page.getByRole('tab', { name: /Файлы/ })).toHaveCount(0)

    // Одно действие из палитры команд
    await page.keyboard.press('Meta+k')
    await page.getByPlaceholder(/Поиск объектов/).fill(`Рабочее пространство: ${name}`)
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()

    // Уборка
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const list = await request.get('/api/v1/workspaces')
    const saved = (await list.json()).items.find((item: { title: string }) => item.title === name)
    await request.delete(`/api/v1/objects/${saved.id}`, { headers })
  })
})
