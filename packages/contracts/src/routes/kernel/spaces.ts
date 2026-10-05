import { z } from 'zod'
import { SpaceRole } from '../../access/levels.js'
import { defineRoutes } from '../../http/route-contract.js'
import {
  AdminSpace,
  Space,
  SpaceCreateInput,
  SpaceKind,
  SpaceMember,
  SpacePatchInput,
} from '../../spaces/space.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Маршруты ядра «spaces» (ADR-0188). Регистрация — `apps/api/src/kernel/spaces/`: http.ts.
 */
export const kernelSpacesRoutes = defineRoutes({
  'GET /spaces': { response: { 200: z.object({ items: z.array(Space) }) } },
  'POST /spaces': { body: SpaceCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /spaces/:id': { params: IdParam, response: { 200: Space } },
  'GET /spaces/:id/members': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(SpaceMember) }) },
  },
  'POST /spaces/:id/members': {
    params: IdParam,
    body: z.object({ userId: z.uuid(), role: SpaceRole }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'PUT /spaces/:id/members/:userId': {
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    body: z.object({ role: SpaceRole }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /spaces/:id/members/:userId': {
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /admin/spaces': {
    query: z.object({
      q: z.string().max(200).optional(),
      kind: SpaceKind.optional(),
    }),
    response: { 200: z.object({ items: z.array(AdminSpace) }) },
  },
  'POST /admin/spaces/:id/admins': {
    params: IdParam,
    body: z.object({ userId: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'PATCH /spaces/:id': {
    params: IdParam,
    body: SpacePatchInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /spaces/:id/archive': { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
  'POST /spaces/:id/unarchive': {
    params: IdParam,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /spaces/:id': { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
})
