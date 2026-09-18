import { defineConfig } from 'vitest/config'

/**
 * Unit-тесты дизайн-системы — только `src`. Визуальные тесты в `visual/`
 * запускает Playwright (`pnpm --filter @kchs/ui test:visual`), не vitest.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
})
