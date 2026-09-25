import type { APIRequestContext } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openWorkspace, test } from './fixtures.js'

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'

/**
 * Входящие, уведомления и профиль (ADR-0153, ADR-0154): группа «Ознакомиться» и массовое
 * «Ознакомлен», таблица настроек уведомлений, размер шрифта. Страницы для ознакомления
 * заводит администратор, дела получает сотрудник (user001) — в своём браузере.
 */
async function headersOf(request: APIRequestContext) {
  const me = await (await request.get('/api/v1/me')).json()
  return { 'x-csrf-token': me.session.csrfToken as string }
}

test.describe('Входящие и профиль: массовые действия, уведомления, шрифт', () => {
  test('«Ознакомиться»: две страницы отмечаются одной кнопкой', async ({ browser, request }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    const headers = await headersOf(request)
    const employee = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    const employeeId = (await (await employee.request.get('/api/v1/me')).json()).user.id as string
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      key: string | null
    }>
    const org = spaces.find((space) => space.key === 'org')
    expect(org).toBeTruthy()

    const titles = [`Памятка дежурному ${run}`, `Порядок приёма смены ${run}`]
    for (const title of titles) {
      const created = await request.post('/api/v1/pages', {
        headers,
        data: { title, spaceId: org?.id, template: 'blank' },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      const id = (await created.json()).id as string
      const published = await request.post(`/api/v1/pages/${id}/publish`, {
        headers,
        data: { note: null },
      })
      expect(published.ok(), await published.text()).toBeTruthy()
      const asked = await request.post(`/api/v1/pages/${id}/acknowledgments`, {
        headers,
        data: { userIds: [employeeId], requireSecondFactor: false },
      })
      expect(asked.ok(), await asked.text()).toBeTruthy()
    }

    const page = await employee.newPage()
    await openWorkspace(page, employee.request)
    await page.getByRole('button', { name: 'Входящие', exact: true }).first().click()
    await page.getByRole('combobox', { name: 'Вид дел' }).click()
    await page.getByRole('option', { name: /^Ознакомиться · \d+$/ }).click()
    for (const title of titles) {
      await page.getByRole('checkbox', { name: new RegExp(title) }).check()
    }
    await expect(page.getByText('Выбрано 2 дела')).toBeVisible()
    await page.getByRole('button', { name: 'Ознакомлен (2)' }).click()
    await expect(page.getByText('Сделано: 2, пропущено: 0')).toBeVisible({ timeout: 20_000 })
    for (const title of titles) {
      await expect(page.getByRole('option', { name: new RegExp(title) })).toHaveCount(0)
    }
    await employee.close()
  })

  test('настройки уведомлений сохраняются, размер шрифта меняет утилиты', async ({ browser }) => {
    const employee = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    const page = await employee.newPage()
    await openWorkspace(page, employee.request)
    await page.getByRole('button', { name: 'Настройки', exact: true }).first().click()

    const cell = page.getByRole('combobox', { name: 'Документы — Почта' })
    // Значение — до открытия: открытый список прячет остальное от специальных возможностей
    const target = (await cell.innerText()).includes('Выключено') ? 'В дайджесте' : 'Выключено'
    await cell.click()
    await page.getByRole('option', { name: target }).click()
    await expect(cell).toHaveText(target)
    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Документы — Почта' })).toHaveText(target)

    await page.getByRole('radio', { name: 'Крупнее' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'l')
    // Текст интерфейса — ступень sm шкалы: 13 px по умолчанию, 15 px «крупнее»
    const body = await page.evaluate(() => getComputedStyle(document.body).fontSize)
    expect(body).toBe('15px')
    await page.getByRole('radio', { name: 'Обычный' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-font-size', 'm')
    await employee.close()
  })
})
