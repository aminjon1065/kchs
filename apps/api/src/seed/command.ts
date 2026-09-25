import { bootstrapPlatform } from '~/bootstrap.js'
import { SecurityPolicyService } from '~/kernel/settings/security-policy.js'
import type { DemoDataResult, DemoProfile } from '~/modules/data/public.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { logger } from '~/shared/logger/index.js'
import { seedDemoData } from './demo-data.js'
import { type EmergencyPackResult, installEmergencyPack } from './packs/emergency/index.js'
import { resetData, runSeed } from './seed.js'

export interface SeedCommandOptions {
  profile: 'minimal' | 'demo'
  /** Очистить данные перед загрузкой — только для стендов разработки и проверки. */
  reset: boolean
  /** Демо-датасеты генератора (ADR-0063): нужен запущенный стек; `none` — без них. */
  data?: DemoProfile | 'none'
  /**
   * Предметный пакет (ADR-0128): по умолчанию демо-профиль ставит пакет ЧС — демо-мир
   * и есть Комитет; чистая установка (`minimal`) — только по явному `emergency`.
   */
  pack?: 'emergency' | 'none'
}

/** Демо-данные: `pnpm db:seed` при разработке и `kchs seed` в образе api. */
export async function seedCommand(options: SeedCommandOptions): Promise<{
  users: number
  units: number
  spaces: number
  datasets: DemoDataResult | null
  pack: EmergencyPackResult | null
}> {
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
  if (options.profile === 'demo') {
    // Демо-мир — общие учётные записи для показа: второй фактор, который ставит
    // `kchs init` рабочей установке, здесь снимается (ADR-0139)
    const relaxed = await db().transaction((tx) =>
      SecurityPolicyService.relaxInstallDefaultForDemo(tx, systemCtx('seed')),
    )
    SecurityPolicyService.invalidate()
    if (relaxed) {
      logger().warn(
        'демо-профиль: обязательный второй фактор администраторов и аудиторов выключен — установка демонстрационная',
      )
    }
  }
  const data = options.data ?? 'none'
  const datasets = data === 'none' ? null : await seedDemoData(data, adminLogin)
  // Пакет — после демо-датасетов: принимает их, а не заводит пустые двойники
  const pack = options.pack ?? (options.profile === 'demo' ? 'emergency' : 'none')
  const installed =
    pack === 'emergency'
      ? await installEmergencyPack(adminLogin, { demo: options.profile === 'demo' })
      : null
  return { ...seeded, datasets, pack: installed }
}
