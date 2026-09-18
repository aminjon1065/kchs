import { Redis } from 'ioredis'
import { config } from '../config/index.js'
import { logger } from '../logger/index.js'

let client: Redis | null = null
let publisher: Redis | null = null

function create(name: string): Redis {
  const redis = new Redis(config().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `kchs-${name}`,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  })
  redis.on('error', (err) => logger().error({ err, name }, 'ошибка redis'))
  return redis
}

/** Основной клиент: кэш, счётчики, ограничения частоты. */
export function redis(): Redis {
  if (!client) client = create('main')
  return client
}

export function redisPublisher(): Redis {
  if (!publisher) publisher = create('pub')
  return publisher
}

/** BullMQ требует собственное соединение с maxRetriesPerRequest=null. */
export function createRedisConnection(name: string): Redis {
  return create(name)
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([client?.quit(), publisher?.quit()])
  client = null
  publisher = null
}

/** Ключи кэша ядра — в одном месте, чтобы не расходились. */
export const cacheKeys = {
  principalSet: (userId: string) => `kchs:principals:${userId}`,
  principalVersion: () => 'kchs:principals:version',
  objectSummary: (id: string) => `kchs:summary:${id}`,
  sessionTouch: (sessionId: string) => `kchs:session:touch:${sessionId}`,
  rateLimit: (bucket: string, key: string) => `kchs:rl:${bucket}:${key}`,
  inboxCounts: (userId: string) => `kchs:inbox:counts:${userId}`,
  presence: (objectId: string) => `kchs:presence:${objectId}`,
  jobProgress: (jobId: string) => `kchs:job:${jobId}`,
  shareGrant: (hash: string) => `kchs:share:grant:${hash}`,
  /** Временные пароли импорта пользователей до одноразовой выгрузки (ADR-0041). */
  usersImportCredentials: (importId: string) => `kchs:users-import:${importId}:credentials`,
  /** Профиль столбца датасета: версия данных и схемы входят в ключ. */
  datasetProfile: (datasetId: string, version: number, schemaVersion: number, field: string) =>
    `kchs:data:profile:${datasetId}:${version}:${schemaVersion}:${field}`,
} as const
