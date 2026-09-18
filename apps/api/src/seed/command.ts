import { bootstrapPlatform } from '~/bootstrap.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { logger } from '~/shared/logger/index.js'
import { resetData, runSeed } from './seed.js'

export interface SeedCommandOptions {
  profile: 'minimal' | 'demo'
  /** Очистить данные перед загрузкой — только для стендов разработки и проверки. */
  reset: boolean
}

/** Демо-данные: `pnpm db:seed` при разработке и `kchs seed` в образе api. */
export async function seedCommand(
  options: SeedCommandOptions,
): Promise<{ users: number; units: number; spaces: number }> {
  await runMigrations()
  if (options.reset) {
    await resetData()
    logger().warn('данные очищены')
  }
  // Системные роли восстанавливаются после очистки
  await bootstrapPlatform()
  return runSeed({
    profile: options.profile,
    adminLogin: process.env.SEED_ADMIN_LOGIN ?? 'admin',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Kchs!Start-2026-7q',
    employeePassword: process.env.SEED_USER_PASSWORD ?? 'Kchs!Work-2026-3v',
  })
}
