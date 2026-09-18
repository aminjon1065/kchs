import { defineConfig, devices } from '@playwright/test'

/**
 * Сквозные сценарии приёмки фазы 0 (04-delivery/04-verification.md §3).
 * Требуется поднятая инфраструктура и запущенные api + web:
 *   docker compose up -d && pnpm db:migrate && pnpm db:seed && pnpm dev
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.KCHS_BASE_URL ?? 'http://localhost:5173',
    locale: 'ru-RU',
    timezoneId: 'Asia/Dushanbe',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1512, height: 900 },
        storageState: './e2e/.auth/admin.json',
      },
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], storageState: './e2e/.auth/admin.json' },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
})
