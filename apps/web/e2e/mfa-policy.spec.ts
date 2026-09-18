import { createHmac } from 'node:crypto'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/** Код TOTP (RFC 6238: SHA-1, 30 с, 6 цифр) — как у приложения-аутентификатора. */
function totp(secret: string, at = Date.now()): string {
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

/**
 * Обязательный второй фактор по политике (P0-E03 S02, 17-security.md §2):
 * администратор включает его для роли в консоли, новый сотрудник с этой ролью
 * меняет временный пароль, подключает TOTP и только после этого видит оболочку.
 */
test.describe('Политика безопасности', () => {
  test('обязательная MFA для роли: администратор включает, сотрудник подключает', async ({
    page,
    request,
    browser,
  }) => {
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const resetPolicy = () =>
      request.patch('/api/v1/admin/security-policy', {
        headers,
        data: { requireMfaRoles: [] },
      })

    try {
      // Администратор отмечает роль в разделе «Безопасность»
      await openWorkspace(page, request)
      await openScreen(page, 'Администрирование')
      await page.getByRole('radio', { name: 'Безопасность' }).click()
      await page.getByRole('checkbox', { name: 'Аудитор безопасности' }).check()
      await page.getByRole('button', { name: 'Сохранить' }).click()
      await expect(page.getByText('Политика безопасности сохранена')).toBeVisible()

      // Новый аудитор с временным паролем
      const login = `auditor-${Date.now().toString(36)}`
      const created = await request.post('/api/v1/users', {
        headers,
        data: { login, lastName: 'Аудитов', firstName: 'Тест', roleKeys: ['security_auditor'] },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      const temporaryPassword = (await created.json()).temporaryPassword as string

      const context = await browser.newContext({ storageState: undefined })
      const auditor = await context.newPage()
      await auditor.goto('/')
      await auditor.getByLabel('Логин или почта').fill(login)
      await auditor.getByLabel('Пароль', { exact: true }).fill(temporaryPassword)
      await auditor.getByRole('button', { name: 'Войти', exact: true }).click()

      // Сначала — свой пароль
      const ownPassword = 'Svoi-Parol-2026!Novyi'
      await auditor.getByLabel('Временный пароль').fill(temporaryPassword)
      await auditor.getByLabel('Новый пароль', { exact: true }).fill(ownPassword)
      await auditor.getByLabel('Повторите новый пароль').fill(ownPassword)
      await auditor.getByRole('button', { name: 'Сменить пароль' }).click()

      // Затем — второй фактор, оболочки ещё нет
      await expect(
        auditor.getByRole('heading', { name: 'Подключите двухфакторную аутентификацию' }),
      ).toBeVisible()
      await expect(auditor.getByRole('tab', { name: /Мой день/ })).toHaveCount(0)
      await auditor.getByRole('button', { name: 'Подключить' }).click()
      await expect(
        auditor.getByRole('img', { name: 'QR-код для приложения-аутентификатора' }),
      ).toBeVisible()
      const secret = (await auditor.locator('code').innerText()).replace(/\s/g, '')
      await auditor.getByLabel('Код из приложения').fill(totp(secret))
      await auditor.getByRole('button', { name: 'Подтвердить' }).click()

      // Коды восстановления показываются один раз, дальше — рабочее пространство
      await expect(auditor.getByRole('heading', { name: 'Коды восстановления' })).toBeVisible()
      await expect(auditor.getByRole('listitem')).toHaveCount(10)
      const done = auditor.getByRole('button', { name: 'Готово' })
      await expect(done).toBeDisabled()
      await auditor.getByRole('checkbox', { name: 'Я сохранил коды в надёжном месте' }).check()
      await done.click()
      await expect(auditor.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
      await context.close()
    } finally {
      await resetPolicy()
    }
  })
})
