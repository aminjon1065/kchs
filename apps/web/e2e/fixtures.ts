import { createHmac } from 'node:crypto'
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test'
import { ACCOUNTS } from './global-setup.js'

export { ACCOUNTS }
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

  const clear = async () => {
    const cleared = await request.put('/api/v1/me/workspace-state', {
      data: { state: null },
      headers: { 'x-csrf-token': csrfToken },
    })
    expect(cleared.ok(), 'сброс состояния рабочего пространства').toBeTruthy()
  }
  await clear()

  // Страница прошлого сценария при закрытии досохраняет вкладки запросом
  // keepalive — он может прийти уже после сброса. Дожидаемся тишины.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const current = await request.get('/api/v1/me/workspace-state')
    if ((await current.json()).state === null) return
    await clear()
  }
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
  // После перезагрузки страницы фокус не на документе, и сочетание не доходит
  // до обработчика: щёлкаем по оболочке и при необходимости повторяем
  const input = page.getByPlaceholder(/Поиск объектов/)
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Meta+k')
  if (!(await input.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+k')
  }
  await expect(input).toBeVisible()
  await input.fill(query)
  // Не первый результат, а пункт с названием экрана: на общем стенде копятся объекты
  // с похожими названиями (личные пространства прогонов)
  await page.getByRole('option').filter({ hasText: query }).first().click()
  await expect(page.getByRole('dialog', { name: 'Палитра команд' })).toBeHidden()
}

/** Код TOTP (RFC 6238: SHA-1, 30 с, 6 цифр) — как у приложения-аутентификатора. */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/[\s=]/g, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [])
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const hmac = createHmac('sha1', key).update(counter).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return value.toString().padStart(6, '0')
}

export const test = base
export { expect }
