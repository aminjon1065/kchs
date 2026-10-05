import { z } from 'zod'
import { cursorPage } from '../../common/pagination.js'
import { defineRoutes } from '../../http/route-contract.js'
import { LineageQuery, ObjectLineage } from '../../objects/lineage.js'
import { LinkCreateInput } from '../../objects/links.js'
import {
  BatchGetInput,
  ObjectPatchInput,
  ObjectRecord,
  ObjectSummary,
  ObjectType,
} from '../../objects/object.js'
import { ListFieldsResponse, ObjectListQuery } from '../../views/view.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Маршруты ядра «objects» (ADR-0188). Регистрация — `apps/api/src/kernel/objects/`: http.ts.
 */
export const kernelObjectsRoutes = defineRoutes({
  'GET /objects/:id': { params: IdParam, response: { 200: ObjectRecord } },
  'PATCH /objects/:id': {
    params: IdParam,
    body: ObjectPatchInput,
    response: { 200: ObjectSummary },
  },
  'DELETE /objects/:id': { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
  'POST /objects/:id/restore': {
    params: IdParam,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /objects/:id/archive': {
    params: IdParam,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /objects/batch-get': {
    body: BatchGetInput,
    response: { 200: z.object({ items: z.array(ObjectSummary) }) },
  },
  'GET /objects/fields': {
    query: z.object({ type: ObjectType.optional(), types: z.string().max(500).optional() }),
    response: { 200: ListFieldsResponse },
  },
  'GET /objects': { query: ObjectListQuery, response: { 200: cursorPage(ObjectSummary) } },
  'GET /me/favorites': { response: { 200: z.object({ items: z.array(ObjectSummary) }) } },
  'PUT /objects/:id/favorite': {
    params: IdParam,
    response: { 200: z.object({ favorite: z.boolean() }) },
  },
  'DELETE /objects/:id/favorite': {
    params: IdParam,
    response: { 200: z.object({ favorite: z.boolean() }) },
  },
  'GET /me/recent': {
    query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
    response: { 200: z.object({ items: z.array(ObjectSummary) }) },
  },
  'PUT /objects/:id/subscription': {
    params: IdParam,
    body: z.object({ subscribed: z.boolean() }),
    response: { 200: z.object({ subscribed: z.boolean() }) },
  },
  'GET /objects/:id/lineage': {
    params: IdParam,
    query: LineageQuery,
    response: { 200: ObjectLineage },
  },
  'GET /objects/:id/links': { params: IdParam },
  'POST /objects/:id/links': {
    params: IdParam,
    body: LinkCreateInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /objects/:id/links/:targetId/:kind': {
    params: z.object({ id: z.uuid(), targetId: z.uuid(), kind: z.string() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /objects/:id/activity': {
    params: IdParam,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
  },
  'GET /trash': { response: { 200: z.object({ items: z.array(ObjectSummary) }) } },
})
