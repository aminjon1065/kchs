import './shared/config/load-env.js'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { renderGatewayRoutes } from './modules/integrations/public.js'
import { closeDb } from './shared/db/client.js'
import { registeredRoutes } from './shared/http/route.js'
import { logger } from './shared/logger/index.js'
import { closeRedis } from './shared/redis/index.js'

/**
 * Белый список шлюза DMZ (ADR-0200): `pnpm --filter @kchs/api dmz:gen` собирает
 * приложение без запуска сервера, берёт реестр маршрутов и пишет
 * `infra/compose/caddy/dmz-routes.caddy`. С `--check` только сверяет файл с
 * таблицей маршрутов — так это делает CI: новый маршрут API по токену или
 * объявленный `exposure: 'public'` без перегенерации не пройдёт.
 */
const FILE = fileURLToPath(
  new URL('../../../infra/compose/caddy/dmz-routes.caddy', import.meta.url),
)

async function main(): Promise<void> {
  const app = await buildApp()
  await app.ready()
  const text = renderGatewayRoutes(registeredRoutes())
  await app.close()

  if (process.argv.includes('--check')) {
    const current = await readFile(FILE, 'utf8').catch(() => '')
    if (current !== text) {
      logger().error(
        { file: FILE },
        'белый список шлюза DMZ отстал от таблицы маршрутов: pnpm --filter @kchs/api dmz:gen',
      )
      process.exitCode = 1
      return
    }
    logger().info({ file: FILE }, 'белый список шлюза DMZ совпадает с таблицей маршрутов')
    return
  }
  await writeFile(FILE, text, 'utf8')
  logger().info({ file: FILE }, 'белый список шлюза DMZ записан')
}

main()
  .catch((error) => {
    logger().error({ err: error }, 'белый список шлюза DMZ не собран')
    process.exitCode = 1
  })
  .finally(async () => {
    await closeRedis().catch(() => undefined)
    await closeDb().catch(() => undefined)
  })
