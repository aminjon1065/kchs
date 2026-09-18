import { defineConfig, devices } from '@playwright/test'

/**
 * Визуальные снимки и доступность дизайн-системы (04-verification.md §1):
 * каждая история Storybook в светлой и тёмной теме + axe.
 * Снимки снимаются в Linux-образе Playwright (`pnpm test:visual`) —
 * отрисовка шрифтов на macOS отличается и дала бы ложные расхождения.
 */
const PORT = 6007

export default defineConfig({
  testDir: './visual',
  snapshotPathTemplate: '{testDir}/__snapshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Отрисовка в закреплённом Linux-образе детерминирована — сравнение строгое.
      // Прежний допуск (0,2 % пикселей всей страницы, порог цвета 0,2) пропускал у
      // маленького компонента новую строку формы, смену шрифта и белый фон вместо
      // surface-2: порог 0,05 различает соседние оттенки поверхностей.
      threshold: 0.05,
      maxDiffPixels: 0,
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ru-RU',
    timezoneId: 'Asia/Dushanbe',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node visual/serve.mjs storybook-static ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 720 } },
    },
  ],
})
