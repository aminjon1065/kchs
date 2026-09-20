import { type Logger, pino } from 'pino'
import { config } from '../config/index.js'
import { routeDiagnostics, traceLogFields, tracingEnabled } from '../telemetry/tracing.js'
import { redactUrl } from './redact-url.js'

/** Поля, которые никогда не попадают в логи (17-security.md §4). */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  'newPassword',
  'currentPassword',
  '*.password',
  '*.secret',
  '*.token',
  '*.secretEnc',
  'DATABASE_URL',
  'REDIS_URL',
  'KCHS_MASTER_KEY',
]

/**
 * Адрес запроса Fastify пишет в каждую строку «incoming request». Свой
 * сериализатор (он перекрывает стандартный: fastify/lib/logger-factory.js
 * отдаёт приоритет сериализаторам переданного экземпляра pino) вычищает из
 * него секрет в пути и строку запроса — см. `redact-url.ts`.
 */
const requestSerializer = (request: {
  method?: string
  url?: string
  host?: string
  ip?: string
}) => ({
  method: request.method,
  url: typeof request.url === 'string' ? redactUrl(request.url) : request.url,
  host: request.host,
  remoteAddress: request.ip,
})

let cached: Logger | null = null

export function logger(): Logger {
  if (cached) return cached
  const env = config()
  const tracing = tracingEnabled()
  cached = pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT, censor: '[скрыто]' },
    serializers: { req: requestSerializer },
    base: { role: env.ROLE },
    // Корреляция с трассами: по trace_id строка лога находит свою трассу в Tempo
    mixin: tracing ? traceLogFields : undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          }
        : undefined,
  })
  if (tracing) routeDiagnostics(cached)
  return cached
}

export type { Logger }
export { redactUrl }
