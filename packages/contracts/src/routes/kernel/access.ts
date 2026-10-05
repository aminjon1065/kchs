import { z } from 'zod'
import {
  AclGrantInput,
  EffectiveAccess,
  ShareLinkCreated,
  ShareLinkInput,
  ShareLinkList,
  ShareLinkOpenInput,
  ShareLinkOpenResult,
} from '../../access/acl.js'
import { Level } from '../../access/levels.js'
import { Principal } from '../../access/principals.js'
import { defineRoutes } from '../../http/route-contract.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Маршруты ядра «access» (ADR-0188). Регистрация — `apps/api/src/kernel/access/`: http.ts.
 */
export const kernelAccessRoutes = defineRoutes({
  'GET /objects/:id/access': {
    params: IdParam,
    response: {
      200: z.object({
        entries: z.array(EffectiveAccess),
        accessMode: z.enum(['inherit', 'restricted']),
        canManage: z.boolean(),
      }),
    },
  },
  'POST /objects/:id/access': {
    params: IdParam,
    body: z.object({ grants: z.array(AclGrantInput).min(1).max(50) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /objects/:id/access': {
    params: IdParam,
    body: z.object({ principal: Principal }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'PUT /objects/:id/access-mode': {
    params: IdParam,
    body: z.object({ mode: z.enum(['inherit', 'restricted']) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /objects/:id/access/explain': {
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
  'GET /objects/:id/share-links': { params: IdParam, response: { 200: ShareLinkList } },
  'POST /objects/:id/share-links': {
    params: IdParam,
    body: ShareLinkInput,
    response: { 200: ShareLinkCreated },
  },
  'POST /share/:token/open': {
    params: z.object({ token: z.string().min(8).max(128) }),
    body: ShareLinkOpenInput,
    response: { 200: ShareLinkOpenResult },
  },
  'DELETE /objects/:id/share-links/:linkId': {
    params: z.object({ id: z.uuid(), linkId: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
