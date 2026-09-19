import './shared/config/load-env.js'
import { writeFile } from 'node:fs/promises'
import { buildApp } from './app.js'
import { bootstrapPlatform } from './bootstrap.js'
import { startCollab, stopCollab } from './kernel/collab/server.js'
import {
  startConsumers,
  startDispatcher,
  stopConsumers,
  stopDispatcher,
} from './kernel/events/index.js'
import { registerMaintenanceJobs, scheduleMaintenance } from './kernel/jobs/maintenance.js'
import { startWorkers, stopWorkers } from './kernel/jobs/runner.js'
import { registerKernelMetrics } from './kernel/metrics.js'
import { registerProcessJobs, scheduleProcessTimers } from './kernel/process/timers.js'
import { startRealtime, stopRealtime } from './kernel/realtime/gateway.js'
import { registerKernelSubscribers } from './kernel/subscribers.js'
import { AuthService } from './modules/identity/public.js'
import {
  registerModulesBackground,
  scheduleModuleJobs,
  startModuleServices,
  stopModuleServices,
} from './modules/index.js'
import { config } from './shared/config/index.js'
import { closeDb, closeQueryRole } from './shared/db/client.js'
import { runMigrations } from './shared/db/migrate.js'
import { logger } from './shared/logger/index.js'
import { closeRedis } from './shared/redis/index.js'
import { startMetrics, stopMetrics } from './shared/telemetry/metrics.js'
import { stopTracing, tracingEnabled, tracingRequested } from './shared/telemetry/tracing.js'

const env = config()
const log = logger()

async function main(): Promise<void> {
  process.env.TZ = env.TZ

  // Метрики — до создания инструментов в приложении и воркерах (ADR-0045)
  if (env.METRICS_PORT) {
    await startMetrics({
      port: env.METRICS_PORT,
      host: env.METRICS_HOST,
      onError: (error) => log.error({ err: error }, 'эндпоинт метрик не запущен'),
    })
  }
  if (tracingRequested() && !tracingEnabled()) {
    log.warn(
      'адрес OTLP задан, но трассы выключены: запустите node с --import ./dist/instrument.js',
    )
  }

  await runMigrations()
  await bootstrapPlatform()

  registerKernelSubscribers()
  registerMaintenanceJobs()
  registerProcessJobs()
  registerModulesBackground()

  const runsApi = env.ROLE === 'api' || env.ROLE === 'all'
  const runsWorker = env.ROLE === 'worker' || env.ROLE === 'all'

  let close: (() => Promise<void>) | null = null

  if (runsApi) {
    const app = await buildApp()
    startRealtime(app, {
      resolveSession: (token) => AuthService.resolveSession(token),
      accessAttributesOf: (session) => AuthService.accessAttributesOf(session),
    })
    // Совместное редактирование — тот же HTTP-сервер, путь /collab (ADR-0070)
    startCollab(app.server, { resolveSession: (token) => AuthService.resolveSession(token) })
    await app.listen({ port: env.PORT, host: env.HOST })
    log.info({ port: env.PORT, role: env.ROLE }, 'kchs api запущен')
    close = async () => {
      // Незаписанные правки документов — в базу до закрытия сокетов
      await stopCollab()
      stopRealtime()
      await app.close()
    }
  }

  if (runsWorker) {
    startDispatcher()
    startConsumers()
    startWorkers()
    await scheduleMaintenance()
    await scheduleProcessTimers()
    await scheduleModuleJobs()
    startModuleServices()
    // Признак жизни для healthcheck контейнера worker (HTTP-сервера у него нет):
    // файл обновляется, пока цикл событий не заблокирован
    const beat = () => writeFile(env.KCHS_HEARTBEAT_FILE, String(Date.now())).catch(() => undefined)
    await beat()
    setInterval(() => void beat(), 10_000).unref()
    log.info('kchs worker запущен')
  }

  registerKernelMetrics({ queues: runsWorker, realtime: runsApi })

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'остановка')
    // Метрики — первыми: опрос Prometheus не должен заново открывать закрытые очереди
    await stopMetrics()
    stopDispatcher()
    await stopModuleServices()
    await stopConsumers()
    await stopWorkers()
    await close?.()
    await stopTracing()
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
