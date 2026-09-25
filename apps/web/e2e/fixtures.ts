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
  // с похожими названиями (личные пространства прогонов). Точное имя — надёжнее подстроки:
  // результаты поиска приходят позже и сдвигают список, а подстрока задела бы и соседние
  // команды («Настройки уведомлений»)
  const loose = page.getByRole('option').filter({ hasText: query }).first()
  await expect(loose).toBeVisible()
  const exact = page.getByRole('option', { name: query, exact: true })
  await ((await exact.count()) > 0 ? exact.first() : loose).click()
  await expect(page.getByRole('dialog', { name: 'Палитра команд' })).toBeHidden()
}

/**
 * Дело во Входящих: список отдаётся страницами, а на общем стенде дел накопились
 * сотни — нужное ищется с подгрузкой «Показать ещё», а не только на первой странице.
 */
export async function openInboxItem(page: Page, name: RegExp): Promise<void> {
  const inbox = page.getByRole('list', { name: 'Входящие' })
  const item = inbox.getByRole('option', { name }).first()
  await expect(inbox.getByRole('option').first()).toBeVisible({ timeout: 20_000 })
  const more = page.getByRole('button', { name: 'Показать ещё' })
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if ((await item.count()) > 0) break
    if (!(await more.isVisible().catch(() => false))) break
    const before = await inbox.getByRole('option').count()
    await more.click()
    await expect.poll(() => inbox.getByRole('option').count()).toBeGreaterThan(before)
  }
  await item.click()
}

/**
 * Служебная учётная запись (ADR-0130): правила работают только от её имени.
 * Заводит её администратор; права — роль «Сотрудник» и роли в пространствах.
 */
export async function createServiceAccount(
  request: APIRequestContext,
  name: string,
  spaces: Array<{ spaceId: string; role: 'viewer' | 'member' | 'editor' }>,
): Promise<{ id: string; name: string }> {
  const me = await (await request.get('/api/v1/me')).json()
  const response = await request.post('/api/v1/service-accounts', {
    headers: { 'x-csrf-token': me.session.csrfToken as string },
    data: { name, roleKeys: ['employee'], spaces },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as { id: string; name: string }
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
