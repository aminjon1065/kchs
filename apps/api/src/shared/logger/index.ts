import { type Logger, pino } from 'pino'
import { config } from '../config/index.js'

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

let cached: Logger | null = null

export function logger(): Logger {
  if (cached) return cached
  const env = config()
  cached = pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT, censor: '[скрыто]' },
    base: { role: env.ROLE },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport:
      env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          }
        : undefined,
  })
  return cached
}

export type { Logger }
