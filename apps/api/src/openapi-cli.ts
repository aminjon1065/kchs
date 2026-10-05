import './shared/config/load-env.js'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { closeDb } from './shared/db/client.js'
import { logger } from './shared/logger/index.js'
import { closeRedis } from './shared/redis/index.js'

/**
 * Выгрузка спецификации OpenAPI без запуска сервера (ADR-0030): `pnpm openapi:gen`
 * пишет `apps/api/openapi.json` для внешних интеграций. CI собирает файл, проверяет
 * (маршрут без описания ответов — ошибка) и публикует артефактом; в git файл не
 * хранится — схемы zod в нём развёрнуты, и он велик для истории. В git — его снимок
 * `openapi.snapshot.json` (ADR-0189): `pnpm contracts:snapshot` собирает оба.
 */
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const

async function main(): Promise<void> {
  const app = await buildApp()
  await app.ready()
  const spec = app.swagger() as {
    servers?: unknown
    paths?: Record<string, Partial<Record<(typeof METHODS)[number], { responses?: object }>>>
    components?: { schemas?: Record<string, unknown> }
  }
  // Адрес установки зависит от окружения — в файле относительный путь
  spec.servers = [{ url: '/api/v1', description: 'Относительно адреса установки' }]

  const operations = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    METHODS.filter((method) => item[method]).map((method) => ({ path, method, op: item[method] })),
  )
  const withoutResponses = operations.filter(({ op }) => !op?.responses)
  if (operations.length === 0) throw new Error('в спецификации нет ни одного маршрута')
  if (withoutResponses.length > 0) {
    throw new Error(
      `маршруты без описания ответов: ${withoutResponses.map((o) => `${o.method} ${o.path}`).join(', ')}`,
    )
  }
  // Ссылка — только на описанный компонент (ADR-0188): рекурсивная схема без имени давала
  // `#/components/schemas/schema0` при пустом списке компонентов
  const prefix = '#/components/schemas/'
  const components = new Set(Object.keys(spec.components?.schemas ?? {}))
  const refs = new Set(
    [...JSON.stringify(spec).matchAll(/"\$ref":"([^"]*)"/g)].map((match) => match[1] ?? ''),
  )
  const broken = [...refs].filter(
    (ref) => !(ref.startsWith(prefix) && components.has(ref.slice(prefix.length))),
  )
  if (broken.length > 0) {
    throw new Error(
      `ссылки на неописанные схемы: ${broken.join(', ')} — назовите схему в openApiComponents ` +
        '(packages/contracts/src/http/components.ts)',
    )
  }

  const out = fileURLToPath(new URL('../openapi.json', import.meta.url))
  await writeFile(out, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  logger().info({ operations: operations.length, file: out }, 'спецификация OpenAPI собрана')
  await app.close()
}

main()
  .catch((error) => {
    logger().error({ err: error }, 'спецификация OpenAPI не собрана')
    process.exitCode = 1
  })
  .finally(async () => {
    await closeRedis().catch(() => undefined)
    await closeDb().catch(() => undefined)
  })
