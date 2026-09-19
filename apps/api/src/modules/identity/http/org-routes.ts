import {
  AdminUser,
  AdminUserCreateInput,
  AdminUserPatchInput,
  ClearanceInput,
  Confidentiality,
  Group,
  LangText,
  OrgUnit,
  OrgUnitInput,
  OrgUnitPatch,
  Position,
  PrincipalRef,
  RoleInfo,
  UserRef,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { hasCapability } from '~/kernel/access/authorize.js'
import { describePrincipals } from '~/kernel/access/principal-refs.js'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { recheckUserRooms } from '~/kernel/realtime/gateway.js'
import { db } from '~/shared/db/client.js'
import {
  groups,
  orgUnits,
  positions,
  roleCapabilities,
  roles,
  userRoles,
  users,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { newId } from '~/shared/ids.js'
import { AuthService } from '../domain/auth-service.js'
import { assertCanManageUser } from '../domain/role-policy.js'
import {
  GroupService,
  OrgService,
  temporaryPasswordFor,
  UserService,
} from '../domain/user-service.js'

export function registerOrgRoutes(route: RouteRegistrar): void {
  // ─── Пикеры: люди, группы, подразделения, должности ───────────────────────
  route({
    method: 'GET',
    url: '/principals/search',
    auth: 'session',
    tags: ['org'],
    summary: 'Поиск принципалов для диалога «Поделиться» и пикеров',
    schema: {
      querystring: z.object({
        q: z.string().max(200).default(''),
        types: z.string().default('user,group,unit,position'),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      response: { 200: z.object({ items: z.array(PrincipalRef) }) },
    },
    handler: async (request) => {
      const types = new Set(request.query.types.split(',').filter(Boolean))
      const q = `%${request.query.q}%`
      const found: Array<{ type: string; id: string }> = []

      if (types.has('user')) {
        const rows = await db()
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.status, 'active'),
              // Скобки обязательны: иначе OR обходил бы условие «активен»
              sql`(${users.displayName} ilike ${q} OR ${users.login} ilike ${q})`,
            ),
          )
          .limit(request.query.limit)
        found.push(...rows.map((r) => ({ type: 'user', id: r.id })))
      }
      if (types.has('group')) {
        const rows = await db()
          .select({ id: groups.id })
          .from(groups)
          .where(sql`${groups.name} ilike ${q}`)
          .limit(10)
        found.push(...rows.map((r) => ({ type: 'group', id: r.id })))
      }
      if (types.has('unit')) {
        const rows = await db()
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(and(eq(orgUnits.isActive, true), sql`${orgUnits.name}->>'ru' ilike ${q}`))
          .limit(10)
        found.push(...rows.map((r) => ({ type: 'unit', id: r.id })))
      }
      if (types.has('position')) {
        const rows = await db()
          .select({ id: positions.id })
          .from(positions)
          .where(sql`${positions.name}->>'ru' ilike ${q}`)
          .limit(10)
        found.push(...rows.map((r) => ({ type: 'position', id: r.id })))
      }
      if (types.has('everyone') && 'все'.includes(request.query.q.toLowerCase())) {
        found.push({ type: 'everyone', id: '*' })
      }

      const refs = await describePrincipals(found as never)
      return { items: [...refs.values()] }
    },
  })

  route({
    method: 'GET',
    url: '/users',
    auth: 'session',
    tags: ['org'],
    summary: 'Пользователи (список и поиск)',
    schema: {
      querystring: z.object({
        q: z.string().max(200).optional(),
        status: z.enum(['active', 'invited', 'blocked', 'deactivated']).optional(),
        unitId: z.uuid().optional(),
        /** Сотрудники с ролью — переход из матрицы ролей. */
        roleKey: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
      response: {
        200: z.object({ items: z.array(AdminUser), nextCursor: z.string().nullable() }),
      },
    },
    handler: async (request) =>
      UserService.list({
        ...request.query,
        withClearance: hasCapability(request.ctx, 'admin.system'),
      }),
  })

  route({
    method: 'PUT',
    url: '/users/:id/clearance',
    auth: { capability: 'admin.system' },
    tags: ['org'],
    summary: 'Допуск сотрудника к грифам (ADR-0080)',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: ClearanceInput,
      response: { 200: z.object({ clearance: Confidentiality }) },
    },
    handler: async (request) => {
      const { to } = await db().transaction((tx) =>
        UserService.setClearance(tx, request.ctx, request.params.id, request.body),
      )
      // Комнаты realtime документов, закрытых новым допуском, — сразу
      await recheckUserRooms(request.params.id)
      return { clearance: to as Confidentiality }
    },
  })

  route({
    method: 'GET',
    url: '/users/:id',
    auth: 'session',
    tags: ['org'],
    summary: 'Карточка сотрудника',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: UserRef } },
    handler: async (request) => {
      const refs = await UserService.refs([request.params.id])
      const ref = refs.get(request.params.id)
      if (!ref) throw errors.notFound('Пользователь')
      return ref
    },
  })

  route({
    method: 'POST',
    url: '/users',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Создать пользователя',
    schema: {
      body: AdminUserCreateInput,
      response: { 200: z.object({ id: z.uuid(), temporaryPassword: z.string().nullable() }) },
    },
    handler: async (request) =>
      db().transaction((tx) => UserService.create(tx, request.ctx, request.body)),
  })

  route({
    method: 'PATCH',
    url: '/users/:id',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Изменить пользователя',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: AdminUserPatchInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        UserService.patch(tx, request.ctx, request.params.id, request.body),
      )
      // После коммита: новые роли и статус действуют со следующего запроса
      await invalidatePrincipalSet(request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/users/:id/reset-mfa',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Сбросить второй фактор пользователя',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      await AuthService.disableMfa(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/users/:id/reset-password',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Выдать временный пароль',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ temporaryPassword: z.string() }) },
    },
    handler: async (request) => {
      await assertCanManageUser(db(), request.ctx, request.params.id)
      const [target] = await db()
        .select({ login: users.login })
        .from(users)
        .where(eq(users.id, request.params.id))
        .limit(1)
      if (!target) throw errors.notFound('Пользователь')
      // Криптостойкий генератор: временный пароль не должен угадываться
      const temporaryPassword = temporaryPasswordFor(target.login)
      await AuthService.setPassword(request.params.id, temporaryPassword, target.login)
      await db()
        .update(users)
        .set({ mustChangePassword: true })
        .where(eq(users.id, request.params.id))
      await AuthService.revokeAllExcept(request.params.id, null)
      await audit(request.ctx, {
        action: AUDIT_ACTIONS.passwordResetByAdmin,
        objectId: request.params.id,
        objectType: 'user',
        severity: 'warning',
      })
      return { temporaryPassword }
    },
  })

  // ─── Оргструктура ─────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/org/units',
    auth: 'session',
    tags: ['org'],
    summary: 'Дерево подразделений',
    schema: { response: { 200: z.object({ items: z.array(OrgUnit) }) } },
    handler: async () => ({ items: await OrgService.tree() }),
  })

  route({
    method: 'POST',
    url: '/org/units',
    auth: { capability: 'org.manage' },
    tags: ['org'],
    summary: 'Создать подразделение',
    schema: { body: OrgUnitInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        OrgService.createUnit(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'PATCH',
    url: '/org/units/:id',
    auth: { capability: 'org.manage' },
    tags: ['org'],
    summary: 'Изменить подразделение',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: OrgUnitPatch,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        OrgService.updateUnit(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/org/positions',
    auth: 'session',
    tags: ['org'],
    summary: 'Должности',
    schema: { response: { 200: z.object({ items: z.array(Position) }) } },
    handler: async () => {
      const rows = await db().select().from(positions).orderBy(positions.rank)
      return {
        items: rows.map((r) => ({ id: r.id, name: r.name, rank: r.rank, unitId: r.unitId })),
      }
    },
  })

  route({
    method: 'POST',
    url: '/org/positions',
    auth: { capability: 'org.manage' },
    tags: ['org'],
    summary: 'Создать должность',
    schema: {
      body: z.object({
        name: LangText,
        rank: z.number().int().default(0),
        unitId: z.uuid().nullable().optional(),
      }),
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => {
      const id = newId()
      await db()
        .insert(positions)
        .values({
          id,
          name: request.body.name,
          rank: request.body.rank,
          unitId: request.body.unitId ?? null,
        })
      return { id }
    },
  })

  // ─── Группы и роли ────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/groups',
    auth: 'session',
    tags: ['org'],
    summary: 'Группы',
    schema: { response: { 200: z.object({ items: z.array(Group) }) } },
    handler: async () => ({ items: await GroupService.list() }),
  })

  route({
    method: 'POST',
    url: '/groups',
    auth: { capability: 'groups.manage' },
    tags: ['org'],
    summary: 'Создать группу',
    schema: {
      body: z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).nullable().optional(),
      }),
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        GroupService.create(tx, request.body.name, request.body.description),
      )
      return { id }
    },
  })

  route({
    method: 'PUT',
    url: '/groups/:id/members',
    auth: { capability: 'groups.manage' },
    tags: ['org'],
    summary: 'Задать состав группы',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({ userIds: z.array(z.uuid()) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        GroupService.setMembers(tx, request.params.id, request.body.userIds),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/roles',
    auth: 'session',
    tags: ['org'],
    summary: 'Роли и способности',
    schema: { response: { 200: z.object({ items: z.array(RoleInfo) }) } },
    handler: async () => {
      const rows = await db().select().from(roles).orderBy(roles.key)
      const caps = await db()
        .select()
        .from(roleCapabilities)
        .where(
          inArray(
            roleCapabilities.roleId,
            rows.map((r) => r.id),
          ),
        )
      const holders = await db()
        .select({ roleId: userRoles.roleId, count: sql<number>`count(DISTINCT ${users.id})::int` })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(eq(users.status, 'active'))
        .groupBy(userRoles.roleId)
      const counts = new Map(holders.map((row) => [row.roleId, row.count]))
      return {
        items: rows.map((row) => ({
          id: row.id,
          key: row.key,
          name: row.name,
          isSystem: row.isSystem,
          capabilities: caps.filter((c) => c.roleId === row.id).map((c) => c.capability),
          userCount: counts.get(row.id) ?? 0,
        })),
      }
    },
  })
}
