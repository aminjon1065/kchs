import { eq, sql } from 'drizzle-orm'
import { DemoData, type DemoDataResult, type DemoProfile } from '~/modules/data/public.js'
import { DemoLayers } from '~/modules/gis/public.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { spaces, users } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'

/** Пространство демо-датасетов: «Общее» — в нём все сотрудники. */
const DEMO_SPACE_KEY = 'org'

/** Движок отвечает и исполняет очередь `transform` (генерация демо-данных). */
async function engineReady(): Promise<boolean> {
  const url = config().ENGINE_INTERNAL_URL
  if (!url) return false
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return false
    const body = (await response.json()) as { queues?: unknown }
    return Array.isArray(body.queues) && body.queues.includes('transform')
  } catch {
    return false
  }
}

/**
 * Демо-датасеты фазы 1 (P1-E10, ADR-0063): генератор движка → файлы → импорт;
 * поверх них — демо-слои и карта фазы 2 (P2-E06).
 * Нужен запущенный стек — api (внутренние маршруты движка), worker (загрузка) и
 * engine; поэтому по умолчанию сид их не грузит, а включает флаг `--data`.
 */
export async function seedDemoData(
  profile: DemoProfile,
  adminLogin: string,
): Promise<DemoDataResult | null> {
  const log = logger().child({ module: 'seed' })
  const [space] = await db()
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.key, DEMO_SPACE_KEY))
    .limit(1)
  if (!space) {
    log.warn('нет пространства «Общее» (профиль minimal) — демо-датасеты пропущены')
    return null
  }
  if (!(await engineReady())) {
    throw new Error(
      'Движок недоступен (ENGINE_INTERNAL_URL): демо-датасеты грузятся при запущенных api, worker и engine',
    )
  }
  const [admin] = await db()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.login}) = ${adminLogin.toLowerCase()}`)
    .limit(1)
  const ctx = systemCtx('seed', { initiatorId: admin?.id ?? null })
  const result = await DemoData.load(ctx, {
    profile,
    spaceId: space.id,
    log: (message, details) => log.info(details ?? {}, message),
  })
  log.info({ profile, ...result }, 'демо-датасеты загружены')
  // Слои над демо-датасетами и карта «Оперативная обстановка» (P2-E06)
  const map = await DemoLayers.seed(ctx, space.id)
  log.info(map, 'демо-слои и карта готовы')
  return result
}
