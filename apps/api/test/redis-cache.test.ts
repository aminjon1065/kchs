// Кэш недоступен — до загрузки помощников и .env (ADR-0175)
import './fixtures/cache-down.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Два Redis (ADR-0175): кэш недоступен — тайлы, запросы, права и счётчики
 * считаются без него, а в долговечный Redis кэшевые ключи не попадают: так
 * проверяется классификация. Отметка версии принципалов — долговечная и
 * случайная: пропавшая не совпадает ни с одним прежним набором.
 */
registerLifecycle()

const { bumpVersionStamp, versionStamp } = await import('../src/shared/redis/index.js')

/** Ключи кэша: в долговечном Redis их быть не должно. */
const CACHE_PATTERNS = [
  'kchs:tile:*',
  'kchs:query:*',
  'kchs:inbox:counts:*',
  'kchs:presence:*',
  'kchs:data:profile:*',
  'kchs:geo:*',
  'kchs:layer-stats:*',
  'kchs:gis:territory-tile:*',
  'kchs:service-layer:*',
]

async function cacheKeysInDurable(): Promise<string[]> {
  const found: string[] = []
  for (const pattern of CACHE_PATTERNS) found.push(...(await redis().keys(pattern)))
  // Наборы принципалов — кэш, отметки версии и поколений — долговечные (ADR-0177)
  for (const key of await redis().keys('kchs:principals:*')) {
    if (key !== 'kchs:principals:version' && !key.startsWith('kchs:principals:gen:')) {
      found.push(key)
    }
  }
  // Прогресс задания — кэш, флаг отмены — долговечный
  for (const key of await redis().keys('kchs:job:*')) {
    if (!key.startsWith('kchs:job:cancel:')) found.push(key)
  }
  return found
}

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  // Прежние файлы слота держали кэш в этом же Redis — их ключи не в счёт
  const left = await cacheKeysInDurable()
  if (left.length > 0) await redis().del(...left)
})

afterAll(() => {
  // Процесс тестов общий для всех файлов: остальным — кэш как обычно
  delete process.env.REDIS_CACHE_URL
})

describe('кэш Redis недоступен', () => {
  it('тайлы, запросы, права и «Входящие» работают без кэша', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Без кэша ${run}`,
        spaceId: fx.spaceId,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'location', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const datasetId = created.json().id as string
    const rows = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: {
        rows: [
          { values: { name: 'Душанбе', location: { type: 'Point', coordinates: [68.78, 38.56] } } },
          { values: { name: 'Хорог', location: { type: 'Point', coordinates: [71.55, 37.49] } } },
        ],
      },
    })
    expect(rows.statusCode, rows.body).toBe(200)

    const layer = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: `Слой без кэша ${run}`, spaceId: fx.spaceId, datasetId },
    })
    expect(layer.statusCode, layer.body).toBe(200)
    // Весь Таджикистан на z6 — один тайл; второй раз тоже считается заново
    for (let attempt = 0; attempt < 2; attempt++) {
      const tile = await call(fx.app, {
        url: `/gis/layers/${layer.json().id}/tiles/6/44/24.pbf`,
        as: fx.admin,
      })
      expect(tile.statusCode, tile.body).toBe(200)
    }

    const spec = { version: 1, source: { kind: 'dataset', id: datasetId }, steps: [] }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call(fx.app, {
        method: 'POST',
        url: '/queries/run',
        as: fx.admin,
        payload: { spec },
      })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json().rows).toHaveLength(2)
      expect(result.json().cached).toBe(false)
    }

    // Набор прав считается на каждый запрос; счётчики «Входящих» — из базы
    for (const user of [fx.users.member, fx.users.viewer]) {
      expect((await call(fx.app, { url: '/me', as: user })).statusCode).toBe(200)
      expect((await call(fx.app, { url: '/inbox/counts', as: user })).statusCode).toBe(200)
    }

    expect(await cacheKeysInDurable()).toEqual([])
    expect(await redis().get('kchs:principals:version')).toBeTruthy()
    // Поколение набора — долговечная отметка: недоступный кэш её не теряет
    expect(await redis().get(`kchs:principals:gen:${fx.users.member.id}`)).toBeTruthy()
  })

  it('«Здоровье системы» показывает кэш отдельной строкой', async () => {
    const health = await call(fx.app, { url: '/admin/health', as: fx.admin })
    expect(health.statusCode, health.body).toBe(200)
    const components = health.json().components as Array<{ name: string; status: string }>
    expect(components.find((item) => item.name === 'redis')?.status).toBe('ok')
    expect(components.find((item) => item.name === 'redis-cache')?.status).toBe('down')
    expect(health.json().status).toBe('degraded')
  })
})

describe('отметка версии', () => {
  it('пропавшая отметка — новая случайная, смена — другая', async () => {
    const key = `kchs:test:stamp:${run}`
    const first = await versionStamp(key)
    expect(await versionStamp(key)).toBe(first)
    // Потеря ключа (сбой Redis, очистка) не возвращает прежнюю версию
    await redis().del(key)
    const recreated = await versionStamp(key)
    expect(recreated).not.toBe(first)
    const bumped = await bumpVersionStamp(key)
    expect(bumped).not.toBe(recreated)
    expect(await versionStamp(key)).toBe(bumped)
    await redis().del(key)
  })
})
