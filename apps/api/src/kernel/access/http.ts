import {
  AclGrantInput,
  EffectiveAccess,
  Level,
  Principal,
  ShareLink,
  ShareLinkInput,
  ShareLinkOpenInput,
  ShareLinkOpenResult,
} from '@kchs/contracts'
import { z } from 'zod'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { grantAccess, listEffectiveAccess, revokeAccess, setAccessMode } from './acl-service.js'
import { authorize, effectiveLevel, loadObject } from './authorize.js'
import { buildUserCtxFor } from './explain.js'
import { createShareLink, listShareLinks, openShareLink, revokeShareLink } from './share-links.js'

const IdParam = z.object({ id: z.uuid() })

export function registerAccessRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/objects/:id/access',
    auth: { action: 'view' },
    tags: ['access'],
    summary: 'Кто имеет доступ к объекту',
    schema: {
      params: IdParam,
      response: {
        200: z.object({
          entries: z.array(EffectiveAccess),
          accessMode: z.enum(['inherit', 'restricted']),
          canManage: z.boolean(),
        }),
      },
    },
    handler: async (request) => {
      const { id } = request.params
      const decision = await authorize(request.ctx, 'view', id)
      const entries = await listEffectiveAccess(id)
      const object = await db().query.objects.findFirst({
        where: (o, { eq }) => eq(o.id, id),
        columns: { accessMode: true },
      })
      return {
        entries,
        accessMode: (object?.accessMode ?? 'inherit') as 'inherit' | 'restricted',
        canManage: decision.level === 'manage' || decision.level === 'owner',
      }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/access',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Выдать доступ',
    schema: {
      params: IdParam,
      body: z.object({ grants: z.array(AclGrantInput).min(1).max(50) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        grantAccess(tx, request.ctx, request.params.id, request.body.grants),
      )
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.aclChanged,
        objectId: request.params.id,
        details: {
          grants: request.body.grants.map(
            (g) => `${g.principal.type}:${g.principal.id}=${g.level}`,
          ),
        },
        severity: 'notice',
      })
      return { ok: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/objects/:id/access',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Отозвать доступ',
    schema: {
      params: IdParam,
      body: z.object({ principal: Principal }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        revokeAccess(tx, request.ctx, request.params.id, request.body.principal),
      )
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.aclChanged,
        objectId: request.params.id,
        details: { revoked: `${request.body.principal.type}:${request.body.principal.id}` },
        severity: 'notice',
      })
      return { ok: true }
    },
  })

  route({
    method: 'PUT',
    url: '/objects/:id/access-mode',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Наследование доступа: включить или разорвать',
    schema: {
      params: IdParam,
      body: z.object({ mode: z.enum(['inherit', 'restricted']) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        setAccessMode(tx, request.ctx, request.params.id, request.body.mode),
      )
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/access/explain',
    auth: { action: 'view' },
    tags: ['access'],
    summary: 'Объяснить доступ конкретного пользователя',
    schema: {
      params: IdParam,
      body: z.object({ userId: z.uuid() }),
      response: {
        200: z.object({
          level: Level,
          reasons: z.array(
            z.object({
              kind: z.string(),
              level: Level,
              messageKey: z.string(),
              params: z.record(z.string(), z.union([z.string(), z.number()])),
              sourceObjectId: z.uuid().nullable().optional(),
            }),
          ),
        }),
      },
    },
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
    method: 'GET',
    url: '/objects/:id/share-links',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Ссылки на объект',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(ShareLink) }) } },
    handler: async (request) => {
      const rows = await listShareLinks(request.params.id)
      return {
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
    method: 'POST',
    url: '/objects/:id/share-links',
    auth: { action: 'share', capability: 'share_links.create' },
    tags: ['access'],
    summary: 'Создать гостевую ссылку',
    schema: {
      params: IdParam,
      body: ShareLinkInput,
      response: { 200: z.object({ id: z.uuid(), token: z.string(), url: z.string() }) },
    },
    handler: async (request) => {
      const result = await db().transaction((tx) =>
        createShareLink(tx, request.ctx, request.params.id, request.body),
      )
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.shareLinkCreated,
        objectId: request.params.id,
        details: { linkId: result.id, hasPassword: Boolean(request.body.password) },
        severity: 'notice',
      })
      return result
    },
  })

  route({
    method: 'POST',
    url: '/share/:token/open',
    auth: 'public',
    tags: ['access'],
    summary: 'Открыть объект по гостевой ссылке',
    rateLimit: { max: 20, timeWindow: '1 minute' },
    schema: {
      params: z.object({ token: z.string().min(8).max(128) }),
      body: ShareLinkOpenInput,
      response: { 200: ShareLinkOpenResult },
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
    method: 'DELETE',
    url: '/objects/:id/share-links/:linkId',
    auth: { action: 'share' },
    tags: ['access'],
    summary: 'Отключить гостевую ссылку',
    schema: {
      params: z.object({ id: z.uuid(), linkId: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) => revokeShareLink(tx, request.params.linkId))
      return { ok: true }
    },
  })
}
