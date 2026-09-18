import '../config/load-env.js'
import { logger } from '../logger/index.js'
import { runMigrations } from './migrate.js'

runMigrations()
  .then((result) => {
    logger().info({ applied: result.applied }, 'миграции завершены')
    process.exit(0)
  })
  .catch((error) => {
    logger().error({ err: error }, 'миграции не выполнены')
    process.exit(1)
  })
