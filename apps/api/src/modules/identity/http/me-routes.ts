import { and, eq, sql } from 'drizzle-orm'
import { employments, orgUnits, positions } from '~/kernel/directory/schema.js'
import { DelegationService, UserService } from '~/kernel/directory/service.js'
import { FeatureService } from '~/kernel/features/service.js'
import { recheckUserRooms } from '~/kernel/realtime/gateway.js'
import { SETTING_KEYS, SettingsService } from '~/kernel/settings/service.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthService } from '../domain/auth-service.js'
import { sessions } from '../schema.js'

export function registerMeRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /me',
    auth: 'session',
    allowPendingPasswordChange: true,
    allowPendingMfaEnrollment: true,
    tags: ['me'],
    summary: 'Профиль, права и контекст текущего пользователя',
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

      const personalSpaceId = await SpaceService.personalOf(ctx.userId)

      const [sessionRow] = await db()
        .select({
          id: sessions.id,
          expiresAt: sessions.expiresAt,
          createdAt: sessions.createdAt,
          csrfToken: sessions.csrfToken,
        })
        .from(sessions)
        .where(eq(sessions.id, ctx.sessionId))
        .limit(1)

      return {
        user: profile,
        personalSpaceId,
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
    route: 'PATCH /me',
    auth: 'session',
    tags: ['me'],
    summary: 'Изменить профиль',
    handler: async (request) => {
      // Профиль — данные справочника ядра: запись и событие `user.updated` (ADR-0184)
      await db().transaction((tx) =>
        UserService.updateProfile(tx, request.ctx, request.ctx.userId, request.body),
      )
      return { ok: true }
    },
  })

  // ─── Пользовательские настройки и состояние рабочего пространства ─────────
  route({
    route: 'GET /me/preferences',
    auth: 'session',
    tags: ['me'],
    summary: 'Настройки интерфейса',
    handler: async (request) => SettingsService.forUser(request.ctx.userId),
  })

  route({
    route: 'PUT /me/preferences',
    auth: 'session',
    tags: ['me'],
    summary: 'Сохранить настройку интерфейса',
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
    route: 'GET /me/workspace-state',
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
    route: 'PUT /me/workspace-state',
    auth: 'session',
    tags: ['me'],
    summary: 'Сохранить состояние рабочего пространства',
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
    route: 'POST /me/admin-mode',
    auth: { capability: 'admin.system' },
    tags: ['me'],
    summary: 'Войти в режим администратора: доступ к объектам с грифом с обоснованием',
    handler: async (request) => {
      const state = await AuthService.enterAdminMode(request.ctx, request.body)
      return state
    },
  })

  route({
    route: 'DELETE /me/admin-mode',
    auth: { capability: 'admin.system' },
    tags: ['me'],
    summary: 'Выйти из режима администратора',
    handler: async (request) => {
      await AuthService.exitAdminMode(request.ctx)
      // Открытые комнаты объектов с грифом закрываются сразу, а не по сроку режима
      await recheckUserRooms(request.ctx.userId)
      return { ok: true }
    },
  })

  // ─── Замещения ────────────────────────────────────────────────────────────
  route({
    route: 'GET /me/delegations',
    auth: 'session',
    tags: ['me'],
    summary: 'Мои замещения',
    handler: async (request) => ({ items: await DelegationService.activeFor(request.ctx.userId) }),
  })

  route({
    route: 'POST /me/delegations',
    auth: 'session',
    tags: ['me'],
    summary: 'Назначить заместителя',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DelegationService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'DELETE /me/delegations/:id',
    auth: { owned: 'DelegationService.stop — только своё замещение' },
    tags: ['me'],
    summary: 'Завершить замещение',
    handler: async (request) => {
      await db().transaction((tx) => DelegationService.stop(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })
}
