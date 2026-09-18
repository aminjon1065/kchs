import '~/shared/config/load-env.js'
import { bootstrapPlatform } from '~/bootstrap.js'
import { closeDb } from '~/shared/db/client.js'
import { runMigrations } from '~/shared/db/migrate.js'
import { logger } from '~/shared/logger/index.js'
import { closeRedis } from '~/shared/redis/index.js'
import { resetData, runSeed } from './seed.js'

const args = process.argv.slice(2)
const profileArg = args.find((a) => a.startsWith('--profile='))?.split('=')[1]
const profile = profileArg === 'minimal' ? 'minimal' : 'demo'
const reset = args.includes('--reset')

async function main(): Promise<void> {
  await runMigrations()
  if (reset) {
    await resetData()
    logger().warn('данные очищены')
  }
  // Системные роли восстанавливаются после очистки
  await bootstrapPlatform()
  const result = await runSeed({
    profile,
    adminLogin: process.env.SEED_ADMIN_LOGIN ?? 'admin',
    adminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'Kchs!Start-2026-7q',
    employeePassword: process.env.SEED_USER_PASSWORD ?? 'Kchs!Work-2026-3v',
  })
  logger().info(result, 'seed выполнен')
}

main()
  .then(async () => {
    await closeRedis()
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    logger().error({ err: error }, 'seed не выполнен')
    await closeRedis().catch(() => undefined)
    await closeDb().catch(() => undefined)
    process.exit(1)
  })
