import '../config/load-env.js'
import { resetData, resetStorage } from '~/seed/seed.js'
import { logger } from '../logger/index.js'
import { cacheRedis, closeRedis, redis } from '../redis/index.js'
import { closeDb } from './client.js'

async function main(): Promise<void> {
  await resetData()
  await resetStorage()
  const keys = await redis().keys('kchs:*')
  if (keys.length > 0) await redis().del(...keys)
  // Отдельный кэш (ADR-0175) — тоже; без него те же ключи уже удалены выше
  const cached = await cacheRedis().keys('kchs:*')
  if (cached.length > 0) await cacheRedis().del(...cached)
  logger().warn({ redisKeys: keys.length + cached.length }, 'данные и кэш очищены')
}

main()
  .then(async () => {
    await closeRedis()
    await closeDb()
    process.exit(0)
  })
  .catch(async (error) => {
    logger().error({ err: error }, 'очистка не выполнена')
    process.exit(1)
  })
