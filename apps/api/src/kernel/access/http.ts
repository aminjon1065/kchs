import { eq } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { hashToken } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { objects } from '../objects/schema.js'
import { grantAccess, listEffectiveAccess, revokeAccess, setAccessMode } from './acl-service.js'
import { authorize, effectiveLevel, loadObject } from './authorize.js'
import { buildUserCtxFor } from './explain.js'
import {
  createShareLink,
  listShareLinks,
  openShareLink,
  revokeShareLink,
  shareLinksAllowed,
} from './share-links.js'

export function registerAccessRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /objects/:id/access',
    auth: { action: 'view' },
    tags: ['access'],
    summary: 'Кто имеет доступ к объекту',
    handler: async (request) => {
      const { id } = request.params
      const decision = await authorize(request.ctx, 'view', id)
      const entries = await listEffectiveAccess(id)
      const [object] = await db()
        .select({ accessMode: objects.accessMode })
        .from(objects)
        .where(eq(objects.id, id))
        .limit(1)
      return {
        entries,
        accessMode: (object?.accessMode ?? 'inherit') as 'inherit' | 'restricted',
        canManage: decision.level === 'manage' || decision.level === 'owner',
      }
    },
  })

  route({
    route: 'POST /objects/:id/access',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Выдать доступ',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await grantAccess(tx, request.ctx, request.params.id, request.body.grants)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.aclChanged,
            objectId: request.params.id,
            details: {
              grants: request.body.grants.map(
                (g) => `${g.principal.type}:${g.principal.id}=${g.level}`,
              ),
            },
            severity: 'notice',
          },
          tx,
        )
      })
      return { ok: true }
    },
  })

  route({
    route: 'DELETE /objects/:id/access',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Отозвать доступ',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        await revokeAccess(tx, request.ctx, request.params.id, request.body.principal)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.aclChanged,
            objectId: request.params.id,
            details: { revoked: `${request.body.principal.type}:${request.body.principal.id}` },
            severity: 'notice',
          },
          tx,
        )
      })
      return { ok: true }
    },
  })

  route({
    route: 'PUT /objects/:id/access-mode',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Наследование доступа: включить или разорвать',
    handler: async (request) => {
      await db().transaction((tx) =>
        setAccessMode(tx, request.ctx, request.params.id, request.body.mode),
      )
      return { ok: true }
    },
  })

  route({
    route: 'POST /objects/:id/access/explain',
    auth: { action: 'view' },
    tags: ['access'],
    summary: 'Объяснить доступ конкретного пользователя',
    handler: async (request) => {
      const targetCtx = await buildUserCtxFor(request.body.userId)
      if (!targetCtx) throw errors.notFound('Пользователь')
      const object = await loadObject(request.params.id)
      if (!object) throw errors.notFound()
      const decision = await effectiveLevel(targetCtx, object)
      return { level: decision.level, reasons: decision.reasons }
    },
  })

  // ─── Гостевые ссылки ───────────────────────────────────────────────────────
  route({
    route: 'GET /objects/:id/share-links',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Ссылки на объект',
    handler: async (request) => {
      const rows = await listShareLinks(request.params.id)
      return {
        allowed: await shareLinksAllowed(),
        items: rows.map((row) => ({
          id: row.id,
          objectId: row.objectId,
          token: '',
          url: `${config().KCHS_BASE_URL}/s/…`,
          level: 'view' as const,
          hasPassword: Boolean(row.passwordHash),
          expiresAt: row.expiresAt,
          maxUses: row.maxUses,
          uses: row.uses,
          includeAttachments: row.includeAttachments,
          createdBy: row.createdBy ?? '',
          createdAt: row.createdAt,
        })),
      }
    },
  })

  route({
    route: 'POST /objects/:id/share-links',
    auth: { action: 'share', capability: 'share_links.create' },
    tags: ['access'],
    summary: 'Создать гостевую ссылку',
    handler: async (request) => {
      return db().transaction(async (tx) => {
        const result = await createShareLink(tx, request.ctx, request.params.id, request.body)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.shareLinkCreated,
            objectId: request.params.id,
            details: { linkId: result.id, hasPassword: Boolean(request.body.password) },
            severity: 'notice',
          },
          tx,
        )
        return result
      })
    },
  })

  route({
    route: 'POST /share/:token/open',
    auth: 'public',
    tags: ['access'],
    summary: 'Открыть объект по гостевой ссылке',
    // Подбор пароля ограничивается для каждой ссылки отдельно: общий лимит по
    // адресу упирался бы в NAT организации, где все гости выходят с одного IP
    rateLimit: {
      max: 20,
      timeWindow: '1 minute',
      keyGenerator: (request) =>
        `share-open:${request.ip}:${hashToken((request.params as { token: string }).token).slice(0, 24)}`,
    },
    handler: async (request) => {
      const result = await openShareLink(request.params.token, request.body.password)
      if (!result) throw errors.notFound('Ссылка недействительна')

      if (!result.requiresPassword) {
        await audit(systemCtx('share-link'), {
          action: AUDIT_ACTIONS.shareLinkOpened,
          actorId: null,
          objectId: result.objectId,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          details: { linkId: result.linkId },
          severity: 'notice',
        })
      }

      const { linkId: _linkId, ...payload } = result
      return payload
    },
  })

  route({
    route: 'DELETE /objects/:id/share-links/:linkId',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Отключить гостевую ссылку',
    handler: async (request) => {
      await db().transaction(async (tx) => {
        const revoked = await revokeShareLink(tx, request.params.id, request.params.linkId)
        if (!revoked) throw errors.notFound('Ссылка')
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.shareLinkRevoked,
            objectId: request.params.id,
            details: { linkId: request.params.linkId },
            severity: 'notice',
          },
          tx,
        )
      })
      return { ok: true }
    },
  })
}
