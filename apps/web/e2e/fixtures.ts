import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test'
import { ACCOUNTS } from './global-setup.js'

export const ADMIN_STATE = ACCOUNTS.admin.file
export const EMPLOYEE_STATE = ACCOUNTS.employee.file

/**
 * Сброс состояния рабочего пространства по API.
 * Вкладки сохраняются на сервере («Продолжить» между днями), поэтому
 * сценарии начинают с чистого листа — иначе они зависят друг от друга.
 */
export async function resetWorkspaceState(request: APIRequestContext): Promise<void> {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), 'сессия действительна').toBeTruthy()
  const csrfToken = (await me.json()).session.csrfToken as string

  const cleared = await request.put('/api/v1/me/workspace-state', {
    data: { state: null },
    headers: { 'x-csrf-token': csrfToken },
  })
  expect(cleared.ok(), 'сброс состояния рабочего пространства').toBeTruthy()
}

/** Открывает приложение с чистым рабочим пространством. */
export async function openWorkspace(page: Page, request: APIRequestContext): Promise<void> {
  await resetWorkspaceState(request)
  await page.addInitScript(() => {
    localStorage.removeItem('kchs.workspace')
    localStorage.removeItem('kchs.appearance')
  })
  await page.goto('/')
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('tab')).toHaveCount(1, { timeout: 15_000 })
}

/** Открывает экран через палитру команд. */
export async function openScreen(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Meta+k')
  const input = page.getByPlaceholder(/Поиск объектов/)
  await expect(input).toBeVisible()
  await input.fill(query)
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Палитра команд' })).toBeHidden()
}

export const test = base
export { expect }
