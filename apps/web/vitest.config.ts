import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** Unit-тесты клиента. Сквозные сценарии (e2e/) запускает Playwright. */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
