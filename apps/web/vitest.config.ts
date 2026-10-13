import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Тесты клиента: логика (`*.test.ts`, Node) и компоненты (`*.test.tsx`, happy-dom и
 * Testing Library, ADR-0209). Сквозные сценарии (e2e/) запускает Playwright.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'happy-dom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
})
