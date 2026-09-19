import type { FastifyRequest } from 'fastify'
import { adminModeActive, type UserCtx } from '~/shared/context.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Служебные опросы оболочки (профиль, счётчики, объявления) — не действия
 * администратора: без них журнал режима тонул бы в фоновых запросах.
 */
const SHELL_POLLING = new Set([
  '/api/v1/me',
  '/api/v1/me/workspace-state',
  '/api/v1/me/preferences',
  '/api/v1/inbox/counts',
  '/api/v1/notifications',
  '/api/v1/announcements',
])

/**
 * Аудит действий в режиме администратора (03-access-model.md §1, ADR-0080):
 * каждый запрос сессии с включённым режимом — запись с маршрутом, объектом,
 * результатом и обоснованием режима. Доступ к объекту с грифом выше допуска
 * вдобавок пишет `document.confidential_access` в `authorize`.
 */
export async function auditAdminModeRequest(
  request: FastifyRequest,
  statusCode: number,
): Promise<void> {
  const ctx = (request as { ctx?: UserCtx }).ctx
  if (!ctx || !adminModeActive(ctx)) return
  const route = request.routeOptions?.url ?? request.url.split('?')[0] ?? ''
  if (request.method === 'GET' && SHELL_POLLING.has(route)) return
  const params = (request.params ?? {}) as Record<string, unknown>
  const objectId = Object.values(params).find(
    (value): value is string => typeof value === 'string' && UUID_RE.test(value),
  )
  await audit(ctx, {
    action: AUDIT_ACTIONS.adminModeAction,
    objectId: objectId ?? null,
    severity: request.method === 'GET' ? 'info' : 'notice',
    details: {
      method: request.method,
      route,
      status: statusCode,
      reason: ctx.adminMode?.reason ?? null,
    },
  })
}
