import { z } from 'zod'

/**
 * Конфигурация процесса. Валидируется схемой при старте: непроходящий .env
 * останавливает запуск (04-delivery/01-project-structure.md §Конфигурация).
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  )

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Каким прокси верить в X-Forwarded-For (адрес клиента для лимитов и аудита).
   * `true` доверял бы любому клиенту и позволял подменять IP. Значения:
   * `false` или список адресов/сетей через запятую (`loopback`, `uniquelocal`, CIDR).
   */
  TRUST_PROXY: z
    .string()
    .default('loopback')
    .refine((v) => v !== 'true', 'TRUST_PROXY=true небезопасен: укажите адреса прокси')
    .transform((v): boolean | string => (v === 'false' ? false : v)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TZ: z.string().default('Asia/Dushanbe'),

  KCHS_BASE_URL: z.url().default('http://localhost:5173'),
  KCHS_API_URL: z.url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
  DATABASE_QUERY_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_FILES: z.string().default('kchs-files'),
  S3_BUCKET_PREVIEWS: z.string().default('kchs-previews'),
  S3_BUCKET_MEDIA: z.string().default('kchs-media'),
  S3_BUCKET_EXPORTS: z.string().default('kchs-exports'),
  S3_BUCKET_TILES: z.string().default('kchs-tiles'),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** Публичный адрес хранилища для подписанных ссылок в браузере. */
  S3_PUBLIC_ENDPOINT: z.string().optional(),

  MEILI_HOST: z.string().min(1),
  MEILI_MASTER_KEY: z.string().min(1),
  /** Префикс имён индексов: интеграционные тесты работают в `test_objects`. */
  MEILI_INDEX_PREFIX: z.string().default(''),

  /** 32 байта base64 — шифрование секретов и TOTP (17-security.md §4). */
  KCHS_MASTER_KEY: z.string().min(16),
  SESSION_COOKIE_NAME: z.string().default('kchs_session'),
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Общий лимит запросов в минуту на пользователя (или адрес до входа), 17-security.md §5.
   * Сквозные прогоны e2e ходят одним пользователем быстрее человека — им лимит поднимают.
   */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(600),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  INTERNAL_SERVICE_TOKEN: z.string().min(16).optional(),

  ENGINE_INTERNAL_URL: z.string().optional(),

  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('kchs <no-reply@kchs.local>'),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPAT_URL: z.string().optional(),

  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Некорректная конфигурация окружения:\n${issues}`)
  }
  return parsed.data
}

export function config(): Env {
  if (!cached) cached = loadEnv()
  return cached
}

export function resetConfigCache(): void {
  cached = null
}

export const isProd = (): boolean => config().NODE_ENV === 'production'
export const isTest = (): boolean => config().NODE_ENV === 'test'
