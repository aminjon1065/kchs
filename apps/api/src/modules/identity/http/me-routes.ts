import { AdminModeInput, AdminModeState, MeResponse, ProfileUpdateInput } from '@kchs/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { FeatureService } from '~/kernel/features/service.js'
import { recheckUserRooms } from '~/kernel/realtime/gateway.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import { db } from '~/shared/db/client.js'
import { employments, orgUnits, positions, spaces, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthService } from '../domain/auth-service.js'
import { DelegationService, UserService } from '../domain/user-service.js'

export function registerMeRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/me',
    auth: 'session',
    allowPendingPasswordChange: true,
    allowPendingMfaEnrollment: true,
    tags: ['me'],
    summary: 'Профиль, права и контекст текущего пользователя',
    schema: { response: { 200: MeResponse } },
    handler: async (request) => {
      const ctx = request.ctx
      const [profile, delegations, mfaEnabled, preferences, features, hiddenScreens] =
        await Promise.all([
          UserService.profile(ctx.userId),
          DelegationService.activeFor(ctx.userId),
          AuthService.mfaEnabled(ctx.userId),
          SettingsService.forUser(ctx.userId),
          FeatureService.enabledKeys(),
          FeatureService.hiddenScreens(),
        ])
      if (!profile) throw errors.notFound('Пользователь')

      const employmentRows = await db()
        .select({
          unitId: employments.unitId,
          unitName: orgUnits.name,
          isPrimary: employments.isPrimary,
          positionId: employments.positionId,
          positionName: positions.name,
        })
        .from(employments)
        .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
        .leftJoin(positions, eq(positions.id, employments.positionId))
        .where(and(eq(employments.userId, ctx.userId), sql`${employments.endsAt} is null`))

      const [personal] = await db()
        .select({ id: spaces.id })
        .from(spaces)
        .where(
          and(eq(spaces.kind, 'personal'), sql`${spaces.settings}->>'ownerId' = ${ctx.userId}`),
        )
        .limit(1)

      const sessionRow = await db().query.sessions.findFirst({
        where: (s, { eq: eqOp }) => eqOp(s.id, ctx.sessionId),
        columns: { id: true, expiresAt: true, createdAt: true, csrfToken: true },
      })

      return {
        user: profile,
        personalSpaceId: personal?.id ?? null,
        roles: ctx.roleKeys,
        capabilities: [...ctx.capabilities],
        units: employmentRows.map((e) => ({
          id: e.unitId,
          name: e.unitName?.ru ?? '',
          isPrimary: e.isPrimary,
        })),
        positions: employmentRows
          .filter((e) => e.positionId)
          .map((e) => ({ id: e.positionId!, name: e.positionName?.ru ?? '' })),
        actingFor: delegations.filter((d) => d.toUser.id === ctx.userId),
        delegatedTo: delegations.filter((d) => d.fromUser.id === ctx.userId),
        mfaEnabled,
        mustChangePassword: ctx.mustChangePassword,
        mfaEnrollmentRequired: ctx.mfaEnrollmentRequired,
        preferences,
        features,
        hiddenScreens,
        clearance: ctx.clearance,
        adminMode: ctx.adminMode,
        session: {
          id: ctx.sessionId,
          expiresAt: sessionRow?.expiresAt ?? new Date().toISOString(),
          createdAt: sessionRow?.createdAt ?? new Date().toISOString(),
          csrfToken: sessionRow?.csrfToken ?? '',
          onBehalfOf: ctx.onBehalfOf,
        },
      }
    },
  })

  route({
    method: 'PATCH',
    url: '/me',
    auth: 'session',
    tags: ['me'],
    summary: 'Изменить профиль',
    schema: { body: ProfileUpdateInput, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      const patch = request.body
      const values: Record<string, unknown> = {}
      if (patch.displayName !== undefined) values.displayName = patch.displayName
      if (patch.firstName !== undefined) values.firstName = patch.firstName
      if (patch.lastName !== undefined) values.lastName = patch.lastName
      if (patch.middleName !== undefined) values.middleName = patch.middleName
      if (patch.email !== undefined) values.email = patch.email
      if (patch.phone !== undefined) values.phone = patch.phone
      if (patch.locale !== undefined) values.locale = patch.locale
      if (patch.timezone !== undefined) values.timezone = patch.timezone

      if (Object.keys(values).length > 0) {
        await db()
          .update(users)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(users.id, request.ctx.userId))
        await invalidatePrincipalSet(request.ctx.userId)
      }
      return { ok: true }
    },
  })

  // ─── Пользовательские настройки и состояние рабочего пространства ─────────
  route({
    method: 'GET',
    url: '/me/preferences',
    auth: 'session',
    tags: ['me'],
    summary: 'Настройки интерфейса',
    handler: async (request) => SettingsService.forUser(request.ctx.userId),
  })

  route({
    method: 'PUT',
    url: '/me/preferences',
    auth: 'session',
    tags: ['me'],
    summary: 'Сохранить настройку интерфейса',
    schema: {
      body: z.object({ key: z.string().max(100), value: z.unknown() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        request.body.value === null || request.body.value === undefined
          ? SettingsService.remove(tx, 'user', request.ctx.userId, request.body.key)
          : SettingsService.set(
              tx,
              request.ctx,
              'user',
              request.ctx.userId,
              request.body.key,
              request.body.value,
              { silent: true },
            ),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/me/workspace-state',
    auth: 'session',
    tags: ['me'],
    summary: 'Сохранённое состояние вкладок и панелей',
    handler: async (request) => {
      const state = await SettingsService.get<unknown>(
        SETTING_KEYS.workspaceState,
        [{ scope: 'user', scopeId: request.ctx.userId }],
        null,
      )
      return { state }
    },
  })

  route({
    method: 'PUT',
    url: '/me/workspace-state',
    auth: 'session',
    tags: ['me'],
    summary: 'Сохранить состояние рабочего пространства',
    schema: {
      body: z.object({ state: z.unknown() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        request.body.state === null || request.body.state === undefined
          ? SettingsService.remove(tx, 'user', request.ctx.userId, SETTING_KEYS.workspaceState)
          : SettingsService.set(
              tx,
              request.ctx,
              'user',
              request.ctx.userId,
              SETTING_KEYS.workspaceState,
              request.body.state,
              { silent: true },
            ),
      )
      return { ok: true }
    },
  })

  // ─── Режим администратора (ADR-0080) ───────────────────────────────────────
  route({
    method: 'POST',
    url: '/me/admin-mode',
    auth: { capability: 'admin.system' },
    tags: ['me'],
    summary: 'Войти в режим администратора: доступ к объектам с грифом с обоснованием',
    schema: { body: AdminModeInput, response: { 200: AdminModeState } },
    handler: async (request) => {
      const state = await AuthService.enterAdminMode(request.ctx, request.body)
      return state
    },
  })

  route({
    method: 'DELETE',
    url: '/me/admin-mode',
    auth: { capability: 'admin.system' },
    tags: ['me'],
    summary: 'Выйти из режима администратора',
    schema: { response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await AuthService.exitAdminMode(request.ctx)
      // Открытые комнаты объектов с грифом закрываются сразу, а не по сроку режима
      await recheckUserRooms(request.ctx.userId)
      return { ok: true }
    },
  })

  // ─── Замещения ────────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/me/delegations',
    auth: 'session',
    tags: ['me'],
    summary: 'Мои замещения',
    handler: async (request) => ({ items: await DelegationService.activeFor(request.ctx.userId) }),
  })

  route({
    method: 'POST',
    url: '/me/delegations',
    auth: 'session',
    tags: ['me'],
    summary: 'Назначить заместителя',
    schema: {
      body: z.object({
        toUserId: z.uuid(),
        scope: z.enum(['all', 'approvals', 'instructions', 'documents', 'meetings']).default('all'),
        startsAt: z.iso.datetime({ offset: true }),
        endsAt: z.iso.datetime({ offset: true }),
        note: z.string().max(500).nullable().optional(),
      }),
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DelegationService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'DELETE',
    url: '/me/delegations/:id',
    auth: 'session',
    tags: ['me'],
    summary: 'Завершить замещение',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) => DelegationService.stop(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })
}
