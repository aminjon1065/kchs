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

/** Пустое значение (`KEY=` в .env, `${KEY:-}` в compose) — «не задано». */
const unset = (v: unknown) => (v === '' ? undefined : v)
const optionalText = z.preprocess(unset, z.string().optional())
const optionalUrl = z.preprocess(unset, z.url().optional())

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
  /**
   * Порт эндпоинта метрик Prometheus (`/metrics`). Не задан — метрики выключены.
   * Отдельный порт не публикуется прокси: его читает Prometheus во внутренней сети.
   * Трассы включает стандартная OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0045).
   */
  METRICS_PORT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(1).max(65535).optional(),
  ),
  METRICS_HOST: z.string().default('127.0.0.1'),

  KCHS_BASE_URL: z.url().default('http://localhost:5173'),
  KCHS_API_URL: z.url().default('http://localhost:3000'),
  /** Сколько ждать ответа на исходящий вызов правила автоматизации (ADR-0096). */
  KCHS_RULE_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

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
  S3_BUCKET_BACKUPS: z.string().default('kchs-backups'),
  /** Каталог базовых карт в бакете тайлов (ADR-0066); интеграционные тесты работают в своём. */
  BASEMAPS_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/)
    .default('basemaps'),
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
  /**
   * Потолок попыток входа в минуту с одного адреса — поверх лимита «адрес + логин»
   * (10 в минуту). Организация за NAT входит с одного адреса: к началу рабочего
   * дня потолок должен покрывать утренний вход всех сотрудников.
   */
  LOGIN_RATE_LIMIT_PER_IP_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(300),
  /**
   * Лимит запросов в минуту на токен публичного API (ADR-0097). У токена может
   * быть свой потолок; этот — по умолчанию для всех остальных.
   */
  API_TOKEN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(1_000_000).default(600),
  /**
   * Разрешить исходящим вебхукам адреса внутренней сети (localhost, 10.0.0.0/8…).
   * По умолчанию запрещено: иначе вебхук становится способом ходить по
   * внутреннему периметру чужими руками (SSRF, 17-security.md §5).
   */
  WEBHOOKS_ALLOW_PRIVATE_ADDRESSES: z.preprocess(unset, bool.default(false)),
  /** Сколько всего повторять доставку вебхука, считая от первой попытки. */
  WEBHOOK_RETRY_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  INTERNAL_SERVICE_TOKEN: z.string().min(16).optional(),
  /** Файл-признак жизни worker для healthcheck контейнера (у worker нет HTTP-сервера). */
  KCHS_HEARTBEAT_FILE: z.string().default('/tmp/kchs-worker.alive'),

  ENGINE_INTERNAL_URL: z.string().optional(),

  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('kchs <no-reply@kchs.local>'),

  /**
   * Telegram-бот (ADR-0061): без токена привязка и канал уведомлений скрыты.
   * Адрес Bot API меняют для тестов (поддельный сервер) и локального Bot API.
   */
  TELEGRAM_BOT_TOKEN: optionalText,
  TELEGRAM_API_URL: z.preprocess(unset, z.url().default('https://api.telegram.org')),
  /** Бот читает сообщения долгим опросом в роли worker; `false` — только отправка. */
  TELEGRAM_POLLING: z.preprocess(unset, bool.default(true)),

  /**
   * Провайдер ИИ (ADR-0061, 13-search-knowledge-ai.md §3): пусто — функции ИИ
   * скрыты. `anthropic` — облако Anthropic, `openai-compat` — свой сервер
   * (vLLM, Ollama) с OpenAI-совместимым API.
   */
  AI_PROVIDER: z.preprocess(unset, z.enum(['anthropic', 'openai-compat']).optional()),
  /** Модель; по умолчанию у Anthropic — `claude-sonnet-5`. */
  AI_MODEL: optionalText,
  ANTHROPIC_API_KEY: optionalText,
  /** Другой адрес Messages API: шлюз организации или поддельный сервер тестов. */
  ANTHROPIC_BASE_URL: optionalUrl,
  /** Базовый адрес OpenAI-совместимого API, например `http://llm:8000/v1`. */
  OPENAI_COMPAT_URL: optionalUrl,
  OPENAI_COMPAT_API_KEY: optionalText,
  /** Суточные лимиты на пользователя: запросы к модели и токены (вход + выход). */
  AI_DAILY_REQUESTS: z.preprocess(unset, z.coerce.number().int().min(0).max(100_000).default(50)),
  AI_DAILY_TOKENS: z.preprocess(
    unset,
    z.coerce.number().int().min(0).max(1_000_000_000).default(300_000),
  ),
  AI_TIMEOUT_MS: z.preprocess(
    unset,
    z.coerce.number().int().min(1000).max(600_000).default(60_000),
  ),
  /**
   * Строжайший гриф документа, текст которого можно отдать модели (ADR-0088):
   * по умолчанию «Для служебного пользования»; `confidential` — только для
   * своего сервера модели в контуре организации.
   */
  AI_DOCUMENTS_MAX_CONFIDENTIALITY: z.preprocess(
    unset,
    z.enum(['public', 'internal', 'confidential', 'secret']).default('internal'),
  ),

  /**
   * Подписка на внешние ICS-календари из частных сетей (ADR-0081): по умолчанию
   * закрыты — адрес задаёт пользователь, а запрос не должен ходить во внутренние
   * сервисы. Включают для календарей закрытого контура (Exchange в интранете).
   */
  CALENDAR_FEEDS_ALLOW_PRIVATE: z.preprocess(unset, bool.default(false)),

  /** Web Push (ADR-0094): пустые ключи — push выключен. */
  PUSH_VAPID_PUBLIC_KEY: z.string().optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().optional(),
  /** Контакт администратора для службы доставки (`mailto:` или адрес). */
  PUSH_CONTACT: z.string().optional(),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  /**
   * Адрес хранилища для записи встреч (ADR-0092): Egress кладёт файл сам, и из
   * его контейнера `localhost` — это он сам. Пусто — тот же адрес, что у api
   * (так в установке целиком в контейнерах).
   */
  S3_EGRESS_ENDPOINT: z.string().optional(),
  /**
   * Куда медиасервер сообщает о готовности записи (ADR-0092). Пусто — адрес
   * считается от `KCHS_API_URL`; в разработке api на хосте, поэтому из
   * контейнера Egress нужен `http://host.docker.internal:3000/api/v1/…`.
   */
  LIVEKIT_WEBHOOK_URL: z.string().optional(),
})

/** Правила, связывающие несколько переменных. */
const CheckedEnv = EnvSchema.superRefine((env, context) => {
  // Запросы пользователей к данным — только под ограниченной ролью (17-security.md §4)
  if (env.NODE_ENV === 'production' && !env.DATABASE_QUERY_URL) {
    context.addIssue({
      code: 'custom',
      path: ['DATABASE_QUERY_URL'],
      message: 'в продакшене обязателен: запросы к данным выполняются под ролью kchs_query',
    })
  }
  // Выбранный провайдер ИИ без адреса или ключа — ошибка настройки, а не «ИИ выключен»
  if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    context.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message: 'нужен при AI_PROVIDER=anthropic',
    })
  }
  if (env.AI_PROVIDER === 'openai-compat' && (!env.OPENAI_COMPAT_URL || !env.AI_MODEL)) {
    context.addIssue({
      code: 'custom',
      path: ['OPENAI_COMPAT_URL'],
      message: 'при AI_PROVIDER=openai-compat нужны OPENAI_COMPAT_URL и AI_MODEL',
    })
  }
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = CheckedEnv.safeParse(source)
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
