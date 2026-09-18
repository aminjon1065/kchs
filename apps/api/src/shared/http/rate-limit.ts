import type { FastifyRequest } from 'fastify'
import { config } from '../config/index.js'
import { hashToken } from '../crypto/secrets.js'
import { errors } from '../errors.js'
import { cacheKeys, redis } from '../redis/index.js'

/**
 * В тестовой среде лимиты сняты: интеграционные тесты выполняют десятки
 * входов подряд, а сами ограничения проверяются отдельными сценариями.
 */
const lifted = () => config().NODE_ENV === 'test'

/** Ограничения частоты запросов (17-security.md §5). */
export function rateLimit(max: number, timeWindow: string): { max: number; timeWindow: string } {
  return lifted() ? { max: 100_000, timeWindow } : { max, timeWindow }
}

/**
 * Ключ «адрес + учётная запись (ссылка, вызов)»: подбор пароля к одной учётной
 * записи не блокирует коллег, выходящих в сеть через тот же NAT. Значение
 * хешируется — в Redis не остаются логины и токены.
 */
export function addressKey(bucket: string, request: FastifyRequest, subject: string): string {
  const digest = hashToken(subject.trim().toLowerCase()).slice(0, 24)
  return `${bucket}:${request.ip ?? 'unknown'}:${digest}`
}

/**
 * Фиксированное окно в Redis — второй счётчик поверх лимита маршрута
 * (плагин допускает один лимит на маршрут). Окно ставится вместе с первым
 * увеличением в одной транзакции: сбой между ними не оставит вечный ключ.
 */
export async function hitRateLimit(
  bucket: string,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const redisKey = cacheKeys.rateLimit(bucket, key)
  const results = await redis()
    .multi()
    .set(redisKey, '0', 'EX', windowSeconds, 'NX')
    .incr(redisKey)
    .ttl(redisKey)
    .exec()
  const count = Number(results?.[1]?.[1] ?? 0)
  const ttl = Number(results?.[2]?.[1] ?? -1)
  return { allowed: count <= max, retryAfter: ttl > 0 ? ttl : windowSeconds }
}

/**
 * Потолок по адресу клиента поверх лимита «адрес + учётная запись»: перебор
 * множества логинов с одного адреса и нагрузка хешированием паролей.
 */
export async function enforceAddressCeiling(
  bucket: string,
  request: FastifyRequest,
  max: number,
  windowSeconds: number,
): Promise<void> {
  if (lifted()) return
  const { allowed, retryAfter } = await hitRateLimit(
    bucket,
    request.ip ?? 'unknown',
    max,
    windowSeconds,
  )
  if (!allowed) throw errors.rateLimited(retryAfter)
}
