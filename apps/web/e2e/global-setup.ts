import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type FullConfig, request as playwrightRequest } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))

export const AUTH_DIR = path.join(here, '.auth')

export const ACCOUNTS = {
  admin: {
    login: 'admin',
    password: process.env.SEED_ADMIN_PASSWORD ?? 'Kchs!Start-2026-7q',
    file: path.join(AUTH_DIR, 'admin.json'),
  },
  employee: {
    login: 'user001',
    password: process.env.SEED_USER_PASSWORD ?? 'Kchs!Work-2026-3v',
    file: path.join(AUTH_DIR, 'employee.json'),
  },
} as const

/**
 * Один вход на роль за прогон: ограничение частоты входов (17-security.md §2)
 * остаётся включённым и в e2e — сессии переиспользуются через storageState.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173'
  mkdirSync(AUTH_DIR, { recursive: true })

  for (const account of Object.values(ACCOUNTS)) {
    const context = await playwrightRequest.newContext({ baseURL })
    const response = await context.post('/api/v1/auth/login', {
      data: { login: account.login, password: account.password, rememberDevice: false },
    })
    if (!response.ok()) {
      throw new Error(
        `Не удалось войти как ${account.login}: ${response.status()} ${await response.text()}`,
      )
    }
    // Вход со вторым фактором отвечает 200 и вызовом, а не сессией: без этой
    // проверки прогон продолжился бы с пустым состоянием и падал бы далеко
    // от причины (ADR-0098)
    const body = (await response.json()) as { status?: string }
    if (body.status !== 'ok') {
      throw new Error(
        `Учётная запись ${account.login} требует второй фактор (${body.status}): ` +
          'снимите ключ входа или TOTP у демо-пользователя перед прогоном',
      )
    }
    await context.storageState({ path: account.file })
    await context.dispose()
  }

  writeFileSync(path.join(AUTH_DIR, '.gitignore'), '*\n', 'utf8')
}
