import { defineConfig } from 'vitest/config'

// scripts/__tests__ — правила совместимости контрактов (ADR-0189)
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/__tests__/*.test.ts'] },
})
