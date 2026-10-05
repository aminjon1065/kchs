import { z } from 'zod'
import { ClearanceInput, Confidentiality } from '../../access/confidentiality.js'
import { PrincipalRef, RoleInfo, RoleInput, RolePatch } from '../../access/principals.js'
import {
  AdminUser,
  AdminUserCreateInput,
  AdminUserPatchInput,
  Group,
  OrgUnit,
  OrgUnitInput,
  OrgUnitPatch,
  Position,
} from '../../admin/org.js'
import {
  ServiceAccount,
  ServiceAccountCreateInput,
  ServiceAccountPatchInput,
} from '../../admin/service-accounts.js'
import { UserKind, UserRef } from '../../auth/session.js'
import { LangText } from '../../common/primitives.js'
import { defineRoutes } from '../../http/route-contract.js'

/**
 * Маршруты ядра «directory» (ADR-0188). Регистрация — `apps/api/src/kernel/directory/`:
 * http.ts, service-account-http.ts.
 */
export const kernelDirectoryRoutes = defineRoutes({
  'GET /principals/search': {
    query: z.object({
      q: z.string().max(200).default(''),
      types: z.string().default('user,group,unit,position'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      /**
       * Служебные учётные записи (ADR-0130): пикеры людей их не показывают,
       * а выдача доступа и участники пространства — показывают с отметкой.
       */
      serviceAccounts: z.enum(['exclude', 'include']).default('exclude'),
    }),
    response: { 200: z.object({ items: z.array(PrincipalRef) }) },
  },
  'GET /principals/describe': {
    query: z.object({ keys: z.string().max(8000).default('') }),
    response: { 200: z.object({ items: z.array(PrincipalRef) }) },
  },
  'GET /users': {
    query: z.object({
      q: z.string().max(200).optional(),
      status: z.enum(['active', 'invited', 'blocked', 'deactivated']).optional(),
      unitId: z.uuid().optional(),
      /** Сотрудники с ролью — переход из матрицы ролей. */
      roleKey: z.string().max(64).optional(),
      /** Сотрудники или служебные учётные записи (ADR-0130). */
      kind: UserKind.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    response: {
      200: z.object({ items: z.array(AdminUser), nextCursor: z.string().nullable() }),
    },
  },
  'PUT /users/:id/clearance': {
    params: z.object({ id: z.uuid() }),
    body: ClearanceInput,
    response: { 200: z.object({ clearance: Confidentiality }) },
  },
  'GET /users/:id': { params: z.object({ id: z.uuid() }), response: { 200: UserRef } },
  'POST /users': {
    body: AdminUserCreateInput,
    response: { 200: z.object({ id: z.uuid(), temporaryPassword: z.string().nullable() }) },
  },
  'PATCH /users/:id': {
    params: z.object({ id: z.uuid() }),
    body: AdminUserPatchInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /users/:id/reset-password': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ temporaryPassword: z.string() }) },
  },
  'GET /org/units': { response: { 200: z.object({ items: z.array(OrgUnit) }) } },
  'POST /org/units': { body: OrgUnitInput, response: { 200: z.object({ id: z.uuid() }) } },
  'PATCH /org/units/:id': {
    params: z.object({ id: z.uuid() }),
    body: OrgUnitPatch,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /org/positions': { response: { 200: z.object({ items: z.array(Position) }) } },
  'POST /org/positions': {
    body: z.object({
      name: LangText,
      rank: z.number().int().default(0),
      unitId: z.uuid().nullable().optional(),
    }),
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'PATCH /org/positions/:id': {
    params: z.object({ id: z.uuid() }),
    body: z.object({
      name: LangText.optional(),
      rank: z.number().int().optional(),
      unitId: z.uuid().nullable().optional(),
    }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'DELETE /org/positions/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /groups': { response: { 200: z.object({ items: z.array(Group) }) } },
  'POST /groups': {
    body: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).nullable().optional(),
    }),
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'PATCH /groups/:id': {
    params: z.object({ id: z.uuid() }),
    body: z.object({
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(1000).nullable().optional(),
    }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /groups/:id/members': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ items: z.array(UserRef) }) },
  },
  'PUT /groups/:id/members': {
    params: z.object({ id: z.uuid() }),
    body: z.object({ userIds: z.array(z.uuid()) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /roles': { response: { 200: z.object({ items: z.array(RoleInfo) }) } },
  'POST /roles': {
    body: RoleInput,
    response: { 200: z.object({ id: z.uuid(), key: z.string() }) },
  },
  'PATCH /roles/:id': {
    params: z.object({ id: z.uuid() }),
    body: RolePatch,
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'DELETE /roles/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.literal(true) }) },
  },
  'GET /service-accounts': { response: { 200: z.object({ items: z.array(ServiceAccount) }) } },
  'GET /service-accounts/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: ServiceAccount },
  },
  'POST /service-accounts': { body: ServiceAccountCreateInput, response: { 200: ServiceAccount } },
  'PATCH /service-accounts/:id': {
    params: z.object({ id: z.uuid() }),
    body: ServiceAccountPatchInput,
    response: { 200: ServiceAccount },
  },
})
