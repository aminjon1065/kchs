import { timingSafeEqual } from 'node:crypto'
import { config } from '../config/index.js'

/**
 * Сервисный токен внутренних маршрутов (движок → api). Сравнение за постоянное
 * время: по времени ответа токен не подобрать. Снаружи маршруты `/internal`
 * закрыты прокси (ADR-0035, Caddyfile).
 */
export function validServiceToken(provided: string | string[] | undefined): boolean {
  const expected = config().INTERNAL_SERVICE_TOKEN
  if (!expected || typeof provided !== 'string') return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
