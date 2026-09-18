import { bootstrapPlatform } from '~/bootstrap.js'
import type { DemoDataResult, DemoProfile } from '~/modules/data/public.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { logger } from '~/shared/logger/index.js'
import { seedDemoData } from './demo-data.js'
import { resetData, runSeed } from './seed.js'

export interface SeedCommandOptions {
  profile: 'minimal' | 'demo'
  /** Очистить данные перед загрузкой — только для стендов разработки и проверки. */
  reset: boolean
  /** Демо-датасеты генератора (ADR-0063): нужен запущенный стек; `none` — без них. */
  data?: DemoProfile | 'none'
}

/** Демо-данные: `pnpm db:seed` при разработке и `kchs seed` в образе api. */
export async function seedCommand(
  options: SeedCommandOptions,
): Promise<{ users: number; units: number; spaces: number; datasets: DemoDataResult | null }> {
  await runMigrations()
  if (options.reset) {
    await resetData()
    logger().warn('данные очищены')
  }
  // Системные роли восстанавливаются после очистки
  await bootstrapPlatform()
  const adminLogin = process.env.SEED_ADMIN_LOGIN ?? 'admin'
  const seeded = await runSeed({
    profile: options.profile,
    adminLogin,
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Kchs!Start-2026-7q',
    employeePassword: process.env.SEED_USER_PASSWORD ?? 'Kchs!Work-2026-3v',
  })
  const data = options.data ?? 'none'
  const datasets = data === 'none' ? null : await seedDemoData(data, adminLogin)
  return { ...seeded, datasets }
}
