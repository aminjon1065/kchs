import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Загружает .env из корня монорепо до чтения конфигурации.
 * Импортируется первым в точках входа (main.ts, CLI, drizzle.config.ts).
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const candidates = [
  process.env.KCHS_ENV_FILE,
  path.resolve(here, '../../../.env'),
  path.resolve(here, '../../../../../.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
].filter(Boolean) as string[]

for (const file of candidates) {
  if (existsSync(file)) {
    process.loadEnvFile(file)
    break
  }
}
