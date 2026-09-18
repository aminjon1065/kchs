import { register } from 'node:module'
import { hostname } from 'node:os'
import {
  type Attributes,
  type Context,
  context,
  DiagLogLevel,
  diag,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-node'

/**
 * Трассы OpenTelemetry (15-admin-operations.md §4, ADR-0045): запрос → SQL →
 * Redis → задание. Включаются, только если задан адрес OTLP
 * (`OTEL_EXPORTER_OTLP_ENDPOINT` или `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`):
 * без него SDK не загружается, модули не перехватываются, а помощники ниже
 * просто вызывают переданную функцию — накладных нет.
 *
 * Запуск — из предзагрузки `src/instrument.ts` (`node --import`), до импорта
 * приложения: иначе http и ioredis уже загружены и не перехватываются.
 */

const TRACER_NAME = 'kchs'
const SERVICE_VERSION = '0.1.0'
/** Модули, импорт которых перехватывается в ESM (остальные грузятся как есть). */
const HOOKED_MODULES = ['http', 'https', 'ioredis']
/**
 * Служебные адреса без трасс: проверки здоровья, опрос метрик Prometheus (его
 * обработчик сам ходит в Postgres и Redis) и долгоживущие соединения.
 */
const UNTRACED_PATHS = ['/health', '/metrics', '/ws/', '/collab/']
/** Первая таблица запроса: `from "objects"`, `into "ops"."outbox"`, `update jobs`. */
const TABLE_RE = /\b(?:from|into|update)\s+((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)/i
const QUERY_TEXT_LIMIT = 2000

let enabled = false
let shutdownProvider: (() => Promise<void>) | null = null

export function tracingEnabled(): boolean {
  return enabled
}

/** Задан ли адрес OTLP — то есть ждёт ли администратор трасс от процесса. */
export function tracingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === 'true') return false
  return Boolean(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT)
}

/** Атрибуты сервиса в трассах и метриках; имя — kchs-api, kchs-worker, kchs-all. */
export function serviceAttributes(env: NodeJS.ProcessEnv = process.env): Attributes {
  return {
    'service.name': env.OTEL_SERVICE_NAME || `kchs-${env.ROLE || 'all'}`,
    'service.version': SERVICE_VERSION,
    'service.instance.id': `${hostname()}:${process.pid}`,
    'deployment.environment.name': env.NODE_ENV || 'development',
  }
}

/**
 * Поднимает SDK трасс. Экспорт — OTLP/HTTP пакетами (BatchSpanProcessor),
 * выборка — стандартные `OTEL_TRACES_SAMPLER`/`OTEL_TRACES_SAMPLER_ARG`.
 */
export async function startTracing(): Promise<boolean> {
  if (enabled || !tracingRequested()) return enabled

  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
    data: { include: HOOKED_MODULES },
  })

  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { registerInstrumentations },
    { HttpInstrumentation },
    { IORedisInstrumentation },
    { UndiciInstrumentation },
    { PostgresJsPreparedQuery },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@opentelemetry/instrumentation-undici'),
    import('drizzle-orm/postgres-js'),
  ])

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes(serviceAttributes()),
    spanProcessors: [redactingProcessor, new BatchSpanProcessor(new OTLPTraceExporter())],
  })
  provider.register()

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) =>
          UNTRACED_PATHS.some((path) => request.url?.startsWith(path)),
        // Фоновые опросы вне запроса или задания не порождают отдельных трасс
        requireParentforOutgoingSpans: true,
      }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      new IORedisInstrumentation({
        requireParentSpan: true,
        // Только имя команды: в ключах и аргументах бывают токены сессий
        dbStatementSerializer: (command) => command,
      }),
    ],
  })

  instrumentPreparedQueries(PostgresJsPreparedQuery.prototype)

  shutdownProvider = () => provider.shutdown()
  enabled = true
  return true
}

/** Досылает накопленные спаны перед остановкой процесса. */
export async function stopTracing(): Promise<void> {
  await shutdownProvider?.().catch(() => undefined)
  shutdownProvider = null
}

/** Ошибки SDK (недоступен коллектор и т. п.) — в общий журнал, а не в stderr. */
export function routeDiagnostics(log: { warn: (fields: object, message: string) => void }): void {
  const write = (message: string, ...args: unknown[]) =>
    log.warn({ otel: args.map(String) }, `opentelemetry: ${message}`)
  const skip = () => undefined
  diag.setLogger(
    { error: write, warn: write, info: skip, debug: skip, verbose: skip },
    DiagLogLevel.WARN,
  )
}

function tracer() {
  return trace.getTracer(TRACER_NAME, SERVICE_VERSION)
}

export interface SpanOptions {
  kind?: SpanKind
  attributes?: Attributes
  /** Родитель вместо активного контекста (задание продолжает трассу запроса). */
  parent?: Context
}

/** Выполняет функцию в дочернем спане; без трасс — просто вызывает её. */
export function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span | undefined) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(undefined)
  const parent = options.parent ?? context.active()
  const span = tracer().startSpan(
    name,
    { kind: options.kind, attributes: options.attributes },
    parent,
  )
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span)
    } catch (error) {
      recordError(span, error)
      throw error
    } finally {
      span.end()
    }
  })
}

export function recordError(span: Span | undefined, error: unknown): void {
  if (!span) return
  span.recordException(error instanceof Error ? error : String(error))
  span.setStatus({ code: SpanStatusCode.ERROR })
}

/**
 * Контекст текущей трассы для передачи в задание: W3C traceparent в JSON —
 * тот же формат, что у телеметрии BullMQ (`opts.telemetry.metadata`).
 */
export function traceMetadata(): string | undefined {
  if (!enabled) return undefined
  const active = context.active()
  const spanContext = trace.getSpanContext(active)
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined
  const carrier: Record<string, string> = {}
  propagation.inject(active, carrier)
  return carrier.traceparent ? JSON.stringify(carrier) : undefined
}

/** Родительский контекст из `traceMetadata()`; без него — новая трасса. */
export function contextFromMetadata(metadata: string | undefined): Context {
  if (!enabled || !metadata) return ROOT_CONTEXT
  try {
    return propagation.extract(ROOT_CONTEXT, JSON.parse(metadata) as Record<string, string>)
  } catch {
    return ROOT_CONTEXT
  }
}

/** Поля корреляции для строки лога: trace_id и span_id активного спана. */
export function traceLogFields(): Record<string, string> {
  const spanContext = trace.getSpanContext(context.active())
  if (!spanContext || !isSpanContextValid(spanContext)) return {}
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId }
}

interface PreparedQueryLike {
  queryString: string
  execute(...args: unknown[]): Promise<unknown>
  all(...args: unknown[]): Promise<unknown>
}

/**
 * Спаны SQL. Для postgres.js нет готового инструментирования, а встроенный
 * трассировщик drizzle отключён — оборачиваем исполнение подготовленного
 * запроса drizzle: через него идут и пул, и транзакции. Текст запроса
 * параметризован (`$1`), значений в спане нет. Вне запроса или задания
 * (фоновые опросы) спаны не создаются.
 */
function instrumentPreparedQueries(prototype: object): void {
  const target = prototype as PreparedQueryLike
  const database = databaseName()
  for (const method of ['execute', 'all'] as const) {
    const original = target[method]
    target[method] = function tracedQuery(this: PreparedQueryLike, ...args: unknown[]) {
      const parent = context.active()
      if (!trace.getSpan(parent)) return original.apply(this, args)
      const text = this.queryString
      const operation = /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase() ?? 'QUERY'
      const table = TABLE_RE.exec(text)?.[1]?.replaceAll('"', '')
      const span = tracer().startSpan(
        table ? `${operation} ${table}` : operation,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system.name': 'postgresql',
            'db.namespace': database,
            'db.operation.name': operation,
            ...(table ? { 'db.collection.name': table } : {}),
            'db.query.text': text.slice(0, QUERY_TEXT_LIMIT),
          },
        },
        parent,
      )
      return context
        .with(trace.setSpan(parent, span), () => original.apply(this, args))
        .then(
          (result) => {
            span.end()
            return result
          },
          (error: unknown) => {
            recordError(span, error)
            span.end()
            throw error
          },
        )
    }
  }
}

function databaseName(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)
  } catch {
    return ''
  }
}

/**
 * Персональные данные в трассы не попадают (17-security.md §4): строка запроса
 * (поиск, токены ссылок) и адрес клиента вычищаются перед экспортом.
 */
const QUERY_ATTRIBUTES = ['http.target', 'http.url', 'url.full']
const HIDDEN_ATTRIBUTES = ['url.query', 'http.client_ip', 'client.address', 'user_agent.original']

const redactingProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnding: (span) => {
    for (const key of QUERY_ATTRIBUTES) {
      const value = span.attributes[key]
      if (typeof value === 'string' && value.includes('?')) {
        span.setAttribute(key, value.slice(0, value.indexOf('?')))
      }
    }
    for (const key of HIDDEN_ATTRIBUTES) {
      if (key in span.attributes) span.setAttribute(key, '[скрыто]')
    }
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
}
