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
  RoleInput,
  RolePatch,
  UserKind,
  UserRef,
} from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { hasCapability } from '~/kernel/access/authorize.js'
import { describePrincipals } from '~/kernel/access/principal-refs.js'
import { bumpPrincipalsVersion, invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import {
  groups,
  orgUnits,
  positions,
  roleCapabilities,
  roles,
  userRoles,
  users,
} from '~/kernel/directory/schema.js'
import { recheckUserRooms } from '~/kernel/realtime/gateway.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { credentials } from './credentials.js'
import { assertCanManageUser } from './role-policy.js'
import { RoleService } from './role-service.js'
import {
  GroupService,
  OrgService,
  PositionService,
  temporaryPasswordFor,
  UserService,
} from './service.js'

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
        /**
         * Служебные учётные записи (ADR-0130): пикеры людей их не показывают,
         * а выдача доступа и участники пространства — показывают с отметкой.
         */
        serviceAccounts: z.enum(['exclude', 'include']).default('exclude'),
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
              request.query.serviceAccounts === 'include' ? undefined : eq(users.kind, 'person'),
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
    url: '/principals/describe',
    auth: 'session',
    tags: ['org'],
    summary: 'Названия принципалов по ключам `user:<id>`, `unit:<id>`… (конструктор маршрутов)',
    readOnly: true,
    schema: {
      querystring: z.object({ keys: z.string().max(8000).default('') }),
      response: { 200: z.object({ items: z.array(PrincipalRef) }) },
    },
    handler: async (request) => {
      // Только именованные принципалы: «все» и роли пространства пикер подписывает сам
      const named = new Set(['user', 'group', 'unit', 'position'])
      const principals = request.query.keys
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean)
        .slice(0, 100)
        .flatMap((key) => {
          const index = key.indexOf(':')
          const type = key.slice(0, index)
          const id = key.slice(index + 1)
          return index > 0 && named.has(type) && z.uuid().safeParse(id).success
            ? [{ type, id }]
            : []
        })
      const refs = await describePrincipals(principals as never)
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
        /** Сотрудники или служебные учётные записи (ADR-0130). */
        kind: UserKind.optional(),
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
      // Пароль, требование смены, отзыв сессий и аудит — одной транзакцией (ADR-0177)
      await db().transaction(async (tx) => {
        await credentials().setPassword(request.params.id, temporaryPassword, target.login, tx)
        await tx
          .update(users)
          .set({ mustChangePassword: true })
          .where(eq(users.id, request.params.id))
        await credentials().revokeSessions(request.params.id, tx)
        await audit(
          request.ctx,
          {
            action: AUDIT_ACTIONS.passwordResetByAdmin,
            objectId: request.params.id,
            objectType: 'user',
            severity: 'warning',
          },
          tx,
        )
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
      const id = await db().transaction((tx) =>
        PositionService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'PATCH',
    url: '/org/positions/:id',
    auth: { capability: 'org.manage' },
    tags: ['org'],
    summary: 'Изменить должность (N86)',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({
        name: LangText.optional(),
        rank: z.number().int().optional(),
        unitId: z.uuid().nullable().optional(),
      }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        PositionService.update(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/org/positions/:id',
    auth: { capability: 'org.manage' },
    tags: ['org'],
    summary: 'Удалить должность, если её никто не занимает (N86)',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) => PositionService.remove(tx, request.ctx, request.params.id))
      return { ok: true }
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
        GroupService.create(tx, request.ctx, request.body.name, request.body.description),
      )
      return { id }
    },
  })

  route({
    method: 'PATCH',
    url: '/groups/:id',
    auth: { capability: 'groups.manage' },
    tags: ['org'],
    summary: 'Переименовать группу или изменить описание (N86)',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(1000).nullable().optional(),
      }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        GroupService.update(tx, request.ctx, request.params.id, request.body),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/groups/:id/members',
    auth: { capability: 'groups.manage' },
    tags: ['org'],
    summary: 'Состав группы (N86)',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ items: z.array(UserRef) }) },
    },
    handler: async (request) => ({ items: await GroupService.members(request.params.id) }),
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
      // Состав группы меняет права доступа: аудит и событие с теми, кого добавили и
      // убрали, — в той же транзакции (ADR-0177)
      await db().transaction(async (tx) => {
        await GroupService.editable(tx, request.params.id)
        await GroupService.setMembers(tx, request.ctx, request.params.id, request.body.userIds)
      })
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
          description: row.description,
          isSystem: row.isSystem,
          capabilities: caps.filter((c) => c.roleId === row.id).map((c) => c.capability),
          userCount: counts.get(row.id) ?? 0,
        })),
      }
    },
  })

  route({
    method: 'POST',
    url: '/roles',
    auth: { capability: 'roles.manage' },
    tags: ['org'],
    summary: 'Своя роль организации (ADR-0165)',
    schema: { body: RoleInput, response: { 200: z.object({ id: z.uuid(), key: z.string() }) } },
    handler: async (request) =>
      db().transaction((tx) => RoleService.create(tx, request.ctx, request.body)),
  })

  route({
    method: 'PATCH',
    url: '/roles/:id',
    auth: { capability: 'roles.manage' },
    tags: ['org'],
    summary: 'Изменить свою роль: название, описание, способности',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: RolePatch,
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (request) => {
      const { capabilitiesChanged } = await db().transaction((tx) =>
        RoleService.update(tx, request.ctx, request.params.id, request.body),
      )
      // После фиксации: права держателей роли меняются сразу, а не через срок кэша
      if (capabilitiesChanged) await bumpPrincipalsVersion()
      return { ok: true as const }
    },
  })

  route({
    method: 'DELETE',
    url: '/roles/:id',
    auth: { capability: 'roles.manage' },
    tags: ['org'],
    summary: 'Удалить свою роль, которую никто не держит',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (request) => {
      await db().transaction((tx) => RoleService.remove(tx, request.ctx, request.params.id))
      return { ok: true as const }
    },
  })
}
