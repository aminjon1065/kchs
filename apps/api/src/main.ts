import './shared/config/load-env.js'
import { writeFile } from 'node:fs/promises'
import { buildApp } from './app.js'
import { bootstrapPlatform } from './bootstrap.js'
import {
  startConsumers,
  startDispatcher,
  stopConsumers,
  stopDispatcher,
} from './kernel/events/index.js'
import { registerMaintenanceJobs, scheduleMaintenance } from './kernel/jobs/maintenance.js'
import { startWorkers, stopWorkers } from './kernel/jobs/runner.js'
import { startRealtime, stopRealtime } from './kernel/realtime/gateway.js'
import { registerKernelSubscribers } from './kernel/subscribers.js'
import { AuthService } from './modules/identity/public.js'
import { registerModulesBackground, scheduleModuleJobs } from './modules/index.js'
import { config } from './shared/config/index.js'
import { closeDb, closeQueryRole } from './shared/db/client.js'
import { runMigrations } from './shared/db/migrate.js'
import { logger } from './shared/logger/index.js'
import { closeRedis } from './shared/redis/index.js'

const env = config()
const log = logger()

async function main(): Promise<void> {
  process.env.TZ = env.TZ

  await runMigrations()
  await bootstrapPlatform()

  registerKernelSubscribers()
  registerMaintenanceJobs()
  registerModulesBackground()

  const runsApi = env.ROLE === 'api' || env.ROLE === 'all'
  const runsWorker = env.ROLE === 'worker' || env.ROLE === 'all'

  let close: (() => Promise<void>) | null = null

  if (runsApi) {
    const app = await buildApp()
    startRealtime(app, { resolveSession: (token) => AuthService.resolveSession(token) })
    await app.listen({ port: env.PORT, host: env.HOST })
    log.info({ port: env.PORT, role: env.ROLE }, 'kchs api запущен')
    close = async () => {
      stopRealtime()
      await app.close()
    }
  }

  if (runsWorker) {
    startDispatcher()
    startConsumers()
    startWorkers()
    await scheduleMaintenance()
    await scheduleModuleJobs()
    // Признак жизни для healthcheck контейнера worker (HTTP-сервера у него нет):
    // файл обновляется, пока цикл событий не заблокирован
    const beat = () => writeFile(env.KCHS_HEARTBEAT_FILE, String(Date.now())).catch(() => undefined)
    await beat()
    setInterval(() => void beat(), 10_000).unref()
    log.info('kchs worker запущен')
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'остановка')
    stopDispatcher()
    await stopConsumers()
    await stopWorkers()
    await close?.()
    await closeRedis()
    await closeQueryRole()
    await closeDb()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error) => {
  log.fatal({ err: error }, 'не удалось запустить kchs')
  process.exit(1)
})
