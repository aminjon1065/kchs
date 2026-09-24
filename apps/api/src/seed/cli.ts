import '~/shared/config/load-env.js'
import { closeDb } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { closeRedis } from '~/shared/redis/index.js'
import { seedCommand } from './command.js'

const args = process.argv.slice(2)
const profileArg = args.find((a) => a.startsWith('--profile='))?.split('=')[1]
// Демо-датасеты генератора: --data=small (50 тыс. происшествий) или --data=demo (5 млн)
const dataArg = args.find((a) => a.startsWith('--data='))?.split('=')[1]
// Предметный пакет: --pack=emergency (демо-профиль ставит его сам), --pack=none — без пакета
const packArg = args.find((a) => a.startsWith('--pack='))?.split('=')[1]

seedCommand({
  profile: profileArg === 'minimal' ? 'minimal' : 'demo',
  reset: args.includes('--reset'),
  data: dataArg === 'small' || dataArg === 'demo' ? dataArg : 'none',
  ...(packArg === 'emergency' || packArg === 'none' ? { pack: packArg } : {}),
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
