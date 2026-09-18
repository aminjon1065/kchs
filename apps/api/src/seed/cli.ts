import '~/shared/config/load-env.js'
import { closeDb } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { closeRedis } from '~/shared/redis/index.js'
import { seedCommand } from './command.js'

const args = process.argv.slice(2)
const profileArg = args.find((a) => a.startsWith('--profile='))?.split('=')[1]

seedCommand({
  profile: profileArg === 'minimal' ? 'minimal' : 'demo',
  reset: args.includes('--reset'),
})
  .then(async (result) => {
    logger().info(result, 'seed выполнен')
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
