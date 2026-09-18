import './src/shared/config/load-env.js'
import { defineConfig } from 'drizzle-kit'

/**
 * Миграции схемы `public` — Drizzle Kit (05-data-model.md §Миграции).
 * Схема `ds` управляется кодом модуля data (physical.ts).
 */
export default defineConfig({
  schema: './src/shared/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['public', 'ops', 'yjs'],
  dbCredentials: {
    url: process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL ?? '',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
