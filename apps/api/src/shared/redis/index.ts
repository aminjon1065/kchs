import { randomInt } from 'node:crypto'
import { Redis, type RedisOptions } from 'ioredis'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

/**
 * Redis платформы — два экземпляра (ADR-0175):
 * - долговечный (`REDIS_URL`, noeviction, AOF): очереди BullMQ, потоки событий,
 *   доступы, флаги, блокировки, счётчики защиты и отметки версий;
 * - кэш (`REDIS_CACHE_URL`, allkeys-lru, без сохранения на диск): то, что можно
 *   пересчитать, — тайлы, результаты запросов, наборы прав, счётчики, присутствие.
 * Без `REDIS_CACHE_URL` кэш живёт в том же Redis (разработка, тесты).
 */

let client: Redis | null = null
let publisher: Redis | null = null
let cacheClient: Redis | null = null

/**
 * Путь запроса: при сбое Redis команда падает за доли секунды (`maxRetriesPerRequest`)
 * или по тайм-ауту зависшего сервера, а не ждёт вечно — api отвечает 503.
 */
export const REQUEST_OPTIONS = {
  maxRetriesPerRequest: 2,
  commandTimeout: 5_000,
} as const satisfies RedisOptions

/**
 * Кэш: недоступный кэш — промах, а не ожидание. Команды без соединения не
 * копятся в очереди и падают сразу; вызывающий считает без кэша.
 */
export const CACHE_OPTIONS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 1_000,
} as const satisfies RedisOptions

/**
 * Долгоживущие соединения: BullMQ требует `maxRetriesPerRequest: null`, блокирующие
 * чтения потоков и подписки ждут восстановления соединения — тайм-аута у них нет.
 */
export const LONG_LIVED_OPTIONS = { maxRetriesPerRequest: null } as const satisfies RedisOptions

function create(
  name: string,
  url: string,
  options: RedisOptions,
  onError: (error: Error) => void = (err) => logger().error({ err, name }, 'ошибка redis'),
): Redis {
  const redis = new Redis(url, {
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `kchs-${name}`,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    ...options,
  })
  redis.on('error', onError)
  return redis
}

/** Адрес кэша: свой экземпляр или, без него, долговечный Redis. */
export function cacheRedisUrl(env: { REDIS_URL: string; REDIS_CACHE_URL?: string }): string {
  return env.REDIS_CACHE_URL || env.REDIS_URL
}

/** Основной клиент: доступы, флаги, блокировки, счётчики защиты, публикация. */
export function redis(): Redis {
  if (!client) client = create('main', config().REDIS_URL, REQUEST_OPTIONS)
  return client
}

/** Публикация outbox в потоки событий: сбой Redis прерывает пачку, а не держит её. */
export function redisPublisher(): Redis {
  if (!publisher) publisher = create('pub', config().REDIS_URL, REQUEST_OPTIONS)
  return publisher
}

/** Клиент кэша; обращаться через `cache` — он переживает недоступный кэш. */
export function cacheRedis(): Redis {
  // Недоступный кэш — не авария: предупреждение раз в минуту, а не строка на каждую
  // попытку переподключения
  cacheClient ??= create('cache', cacheRedisUrl(config()), CACHE_OPTIONS, (error) =>
    cacheFailed(error, 'connect'),
  )
  return cacheClient
}

/** BullMQ, блокирующие чтения и подписки — собственное соединение с долговечным Redis. */
export function createRedisConnection(name: string): Redis {
  return create(name, config().REDIS_URL, LONG_LIVED_OPTIONS)
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([client?.quit(), publisher?.quit(), cacheClient?.quit()])
  client = null
  publisher = null
  cacheClient = null
}

/**
 * Дождаться готовности соединения: ложь — не дождались за отведённое время или
 * попытка соединения не удалась (сбой не ждём до тайм-аута).
 */
function whenReady(client: Redis, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer)
      client.off('ready', onReady)
      client.off('error', onFailed)
      client.off('close', onFailed)
      resolve(ready)
    }
    const onReady = () => finish(true)
    const onFailed = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    client.once('ready', onReady)
    client.once('error', onFailed)
    client.once('close', onFailed)
  })
}

/**
 * Кэш отвечает («Здоровье системы»). Клиент кэша создаётся при первом обращении и
 * команд без соединения не копит — сначала дожидаемся соединения.
 */
export async function pingCache(timeoutMs = 2_000): Promise<void> {
  const client = cacheRedis()
  if (!(await whenReady(client, timeoutMs))) throw new Error('кэш не подключился')
  await client.ping()
}

// ─── Кэш ─────────────────────────────────────────────────────────────────────

/** Предупреждение о сбое кэша — не чаще раза в минуту на процесс, без потока строк. */
let lastWarning = 0
function cacheFailed(error: unknown, operation: string): void {
  const now = Date.now()
  if (now - lastWarning < 60_000) return
  lastWarning = now
  logger().warn({ err: error, operation }, 'кэш Redis недоступен — считаем без кэша')
}

/**
 * Первое соединение процесса ещё устанавливается — подождать его немного: иначе
 * первые операции каждого нового процесса (старт api, `kchs seed`) промахивались бы.
 * Разорванное или недоступное соединение не ждём — промах сразу.
 */
const FIRST_CONNECT_WAIT_MS = 500

async function attempt<T>(operation: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const client = cacheRedis()
    if (client.status === 'connecting' || client.status === 'connect') {
      await whenReady(client, FIRST_CONNECT_WAIT_MS)
    }
    return await run()
  } catch (error) {
    cacheFailed(error, operation)
    return fallback
  }
}

/**
 * Операции кэша (ADR-0175). Сбой кэша — промах: чтение даёт `null`, запись и
 * удаление молча пропускаются (удаление возвращает ложь — вызывающий, которому
 * важна инвалидация, страхуется сам).
 */
export const cache = {
  get: (key: string) => attempt('get', () => cacheRedis().get(key), null),
  getBuffer: (key: string) => attempt('get', () => cacheRedis().getBuffer(key), null),
  async set(key: string, value: string | Buffer, ttlSeconds: number): Promise<void> {
    await attempt('set', () => cacheRedis().set(key, value, 'EX', ttlSeconds), null)
  },
  /** Истина — ключи удалены (или их не было); ложь — кэш недоступен. */
  async del(...keys: string[]): Promise<boolean> {
    if (keys.length === 0) return true
    return attempt(
      'del',
      async () => {
        await cacheRedis().del(...keys)
        return true
      },
      false,
    )
  },
  hgetall: (key: string) => attempt('hgetall', () => cacheRedis().hgetall(key), {}),
  async hset(key: string, field: string, value: string, ttlSeconds: number): Promise<void> {
    await attempt(
      'hset',
      () => cacheRedis().multi().hset(key, field, value).expire(key, ttlSeconds).exec(),
      null,
    )
  },
  async hdel(key: string, ...fields: string[]): Promise<void> {
    if (fields.length === 0) return
    await attempt('hdel', () => cacheRedis().hdel(key, ...fields), 0)
  },
}

// ─── Отметки версий ──────────────────────────────────────────────────────────

/** Случайная отметка версии: счётчик после потери ключа совпал бы с прежним. */
const randomStamp = () => randomInt(1, 2 ** 47)

/**
 * Отметка версии в долговечном Redis (ADR-0175): по ней кэши понимают, что их
 * содержимое устарело. Пропавшая отметка (сбой Redis, очистка) заменяется новой
 * случайной — ни один кэш прежней версии с ней не совпадёт, устаревшее не
 * прочитается.
 */
export async function versionStamp(key: string): Promise<number> {
  const current = await redis().get(key)
  if (current) return Number(current)
  await redis().set(key, String(randomStamp()), 'NX')
  return Number(await redis().get(key))
}

/** Новая отметка: все кэши прежней версии недействительны. */
export async function bumpVersionStamp(key: string): Promise<number> {
  const next = randomStamp()
  await redis().set(key, String(next))
  return next
}

/**
 * Ключи Redis приложения — в одном месте, чтобы не расходились. Где лежит ключ
 * (долговечный Redis или кэш) — таблица в ADR-0175: здесь кэшевые помечены.
 */
export const cacheKeys = {
  /** Кэш: набор принципалов пользователя (сверяется с `principalVersion`). */
  principalSet: (userId: string) => `kchs:principals:${userId}`,
  /** Долговечный: отметка версии наборов принципалов. */
  principalVersion: () => 'kchs:principals:version',
  /**
   * Долговечный: отметка поколения набора принципалов пользователя (ADR-0177) —
   * случайная, как версия: пропавшая заменяется новой, и набор, записанный до
   * сброса, с ней не совпадёт.
   */
  principalGeneration: (userId: string) => `kchs:principals:gen:${userId}`,
  /** Долговечный: счётчики защиты от подбора (вход, второй фактор, ссылки). */
  rateLimit: (bucket: string, key: string) => `kchs:rl:${bucket}:${key}`,
  /** Кэш: счётчики «Входящих». */
  inboxCounts: (userId: string) => `kchs:inbox:counts:${userId}`,
  /** Кэш: кто смотрит объект. */
  presence: (objectId: string) => `kchs:presence:${objectId}`,
  /** Кэш: последний прогресс задания. */
  jobProgress: (jobId: string) => `kchs:job:${jobId}`,
  /** Долговечный: флаг отмены задания (ADR-0172) — его читает и движок, имя не менять без него. */
  jobCancel: (jobId: string) => `kchs:job:cancel:${jobId}`,
  /** Долговечный: токен доступа гостя по ссылке. */
  shareGrant: (hash: string) => `kchs:share:grant:${hash}`,
  /** Долговечный: служебный токен страницы печати (ADR-0078) и его область — для отзыва. */
  printGrant: (hash: string) => `kchs:print:grant:${hash}`,
  printScope: (scope: string) => `kchs:print:scope:${scope}`,
  /** Долговечный: временные пароли импорта пользователей до одноразовой выгрузки (ADR-0041). */
  usersImportCredentials: (importId: string) => `kchs:users-import:${importId}:credentials`,
  /** Кэш: профиль столбца датасета; версия данных и схемы входят в ключ. */
  datasetProfile: (datasetId: string, version: number, schemaVersion: number, field: string) =>
    `kchs:data:profile:${datasetId}:${version}:${schemaVersion}:${field}`,
} as const
