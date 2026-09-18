import { trace } from '@opentelemetry/api'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { isAppError } from '../errors.js'
import { meter, metricsEnabled } from '../telemetry/metrics.js'
import { tracingEnabled } from '../telemetry/tracing.js'

/** Границы гистограммы: отдельная граница на бюджете p95 ≤ 200 мс (04-verification.md §4). */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2.5, 5, 10]

/**
 * Наблюдаемость HTTP (15-admin-operations.md §4): спан запроса получает шаблон
 * маршрута, requestId и пользователя; длительность пишется в гистограмму по
 * маршрутам. Без трасс и метрик плагин не добавляет ни одного хука.
 */
export const telemetryPlugin = fp(async (app: FastifyInstance) => {
  if (tracingEnabled()) {
    // Спан сервера открывает инструментирование http; здесь он становится
    // «GET /api/v1/objects/:id» вместо «GET» и связывается с логами по requestId
    app.addHook('onRequest', async (request) => {
      const span = trace.getActiveSpan()
      if (!span) return
      const route = request.routeOptions.url
      if (route) {
        span.updateName(`${request.method} ${route}`)
        span.setAttribute('http.route', route)
      }
      span.setAttribute('kchs.request_id', request.id)
    })
    app.addHook('preHandler', async (request) => {
      const userId = userOf(request)
      if (userId) trace.getActiveSpan()?.setAttribute('enduser.id', userId)
    })
    // Ошибки клиента (4xx) — штатные ответы, исключение пишется только для 5xx
    app.addHook('onError', async (_request, _reply, error) => {
      const status = isAppError(error)
        ? error.status
        : ((error as { statusCode?: number }).statusCode ?? 500)
      if (status >= 500) trace.getActiveSpan()?.recordException(error)
    })
  }

  if (metricsEnabled()) {
    const duration = meter().createHistogram('http.server.request.duration', {
      unit: 's',
      description: 'Длительность обработки HTTP-запроса',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    })
    app.addHook('onResponse', async (request, reply) => {
      duration.record(reply.elapsedTime / 1000, {
        'http.request.method': request.method,
        // Без шаблона маршрута (404) — одна метка, а не адрес: иначе метки множатся
        'http.route': request.routeOptions.url ?? 'unmatched',
        'http.response.status_code': reply.statusCode,
      })
    })
  }
})

function userOf(request: FastifyRequest): string | undefined {
  return (request as { ctx?: { userId?: string } }).ctx?.userId
}
