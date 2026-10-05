import QRCode from 'qrcode'
import { SecurityPolicyService } from '~/kernel/settings/security-policy.js'
import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { addressKey, enforceAddressCeiling, rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthService } from '../domain/auth-service.js'
import { sendPasswordReset } from '../domain/notify.js'
import { SsoService } from '../domain/oidc.js'
import { PasskeyService } from '../domain/passkeys.js'
import { MFA_COOKIE, setMfaCookie, setSessionCookie } from './session-cookie.js'

export function registerAuthRoutes(route: RouteRegistrar): void {
  const env = config()

  route({
    route: 'POST /auth/login',
    auth: 'public',
    tags: ['auth'],
    summary: 'Вход по логину и паролю',
    // Подбор пароля — по адресу и логину: коллеги за тем же NAT не блокируются
    // (17-security.md §5); общий потолок адреса — в обработчике
    rateLimit: {
      ...rateLimit(10, '1 minute'),
      keyGenerator: (request) =>
        addressKey('login', request, (request.body as { login?: string } | undefined)?.login ?? ''),
    },
    handler: async (request, reply) => {
      await enforceAddressCeiling('login-ip', request, env.LOGIN_RATE_LIMIT_PER_IP_PER_MINUTE, 60)
      const meta = {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      }
      const result = await AuthService.login(request.body.login, request.body.password, meta)

      if (result.status === 'mfa_required') {
        setMfaCookie(reply, result.challengeToken)
        return {
          status: 'mfa_required',
          challengeId: result.challengeId,
          expiresAt: result.expiresAt,
          methods: result.methods,
        }
      }

      setSessionCookie(reply, result.sessionToken, result.expiresAt)
      return { status: result.status, csrfToken: result.csrfToken, expiresAt: result.expiresAt }
    },
  })

  route({
    route: 'POST /auth/mfa/verify',
    auth: 'public',
    tags: ['auth'],
    summary: 'Подтверждение второго фактора',
    // По адресу и вызову входа; сам вызов допускает не больше 5 попыток
    rateLimit: {
      ...rateLimit(10, '1 minute'),
      keyGenerator: (request) => addressKey('mfa', request, request.cookies?.[MFA_COOKIE] ?? ''),
    },
    handler: async (request, reply) => {
      const challengeToken = request.cookies?.[MFA_COOKIE]
      if (!challengeToken) {
        return reply
          .status(401)
          .send({ code: 'unauthorized', title: 'Войдите заново', status: 401 })
      }
      const meta = {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      }
      const result = await AuthService.verifyMfa(challengeToken, request.body.code, meta)
      reply.clearCookie(MFA_COOKIE, { path: '/' })
      setSessionCookie(reply, result.sessionToken, result.expiresAt)
      return {
        status: result.mustChangePassword ? ('password_change_required' as const) : ('ok' as const),
        csrfToken: result.csrfToken,
      }
    },
  })

  route({
    route: 'POST /auth/logout',
    auth: 'session',
    allowPendingPasswordChange: true,
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Выход',
    handler: async (request, reply) => {
      await AuthService.logout(request.ctx)
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      return { ok: true, endSessionUrl: await SsoService.endSessionUrl() }
    },
  })

  route({
    route: 'POST /auth/password-reset',
    auth: 'public',
    tags: ['auth'],
    summary: 'Запрос восстановления доступа',
    // Письма одному адресату — не чаще 5 за 10 минут; с одного адреса — не больше 50
    rateLimit: {
      ...rateLimit(5, '10 minutes'),
      keyGenerator: (request) =>
        addressKey('reset', request, (request.body as { login?: string } | undefined)?.login ?? ''),
    },
    handler: async (request) => {
      await enforceAddressCeiling('reset-ip', request, 50, 600)
      const result = await AuthService.requestPasswordReset(request.body.login)
      if (result) await sendPasswordReset(result.userId, result.token)
      // Ответ одинаков вне зависимости от существования учётной записи
      return { ok: true }
    },
  })

  route({
    route: 'POST /auth/password-reset/confirm',
    auth: 'public',
    tags: ['auth'],
    summary: 'Установка нового пароля по ссылке',
    rateLimit: {
      ...rateLimit(10, '10 minutes'),
      keyGenerator: (request) =>
        addressKey(
          'reset-confirm',
          request,
          (request.body as { token?: string } | undefined)?.token ?? '',
        ),
    },
    handler: async (request) => {
      await AuthService.confirmPasswordReset(request.body.token, request.body.newPassword)
      return { ok: true }
    },
  })

  route({
    route: 'POST /me/password',
    auth: 'session',
    allowPendingPasswordChange: true,
    tags: ['auth'],
    summary: 'Смена пароля',
    handler: async (request) => {
      await AuthService.changePassword(
        request.ctx,
        request.body.currentPassword,
        request.body.newPassword,
        request.body.revokeOtherSessions,
      )
      return { ok: true }
    },
  })

  // ─── MFA ───────────────────────────────────────────────────────────────────
  route({
    route: 'POST /me/mfa/setup',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Начать подключение TOTP',
    handler: async (request) => {
      const { secret, otpauthUrl } = await AuthService.startMfaSetup(request.ctx)
      // Тёмные модули на белом поле с отступом: камера читает код в любой теме интерфейса
      const qrSvg = await QRCode.toString(otpauthUrl, {
        type: 'svg',
        margin: 2,
        width: 200,
        color: { dark: '#000000', light: '#FFFFFF' },
      })
      return { secret, otpauthUrl, qrSvg }
    },
  })

  route({
    route: 'POST /me/mfa/enable',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Подтвердить и включить TOTP',
    handler: async (request) => ({
      codes: await AuthService.enableMfa(request.ctx, request.body.code),
    }),
  })

  route({
    route: 'DELETE /me/mfa',
    auth: 'session',
    tags: ['auth'],
    summary: 'Отключить TOTP',
    handler: async (request) => {
      const policy = await SecurityPolicyService.current()
      // Ключ входа — такой же второй фактор (ADR-0098): если он есть, код
      // приложения можно отключить, требование политики остаётся закрытым
      if (
        SecurityPolicyService.requiresMfa(policy, request.ctx.roleKeys) &&
        !(await PasskeyService.hasKeys(request.ctx.userId))
      ) {
        throw errors.policyViolation(
          'Политика безопасности требует второй фактор для вашей роли — отключить его нельзя',
        )
      }
      const ok =
        (await AuthService.verifyTotp(request.ctx.userId, request.body.code)) ||
        (await AuthService.consumeRecoveryCode(request.ctx.userId, request.body.code))
      if (!ok) return { ok: false }
      await AuthService.disableMfa(request.ctx, request.ctx.userId)
      return { ok: true }
    },
  })

  // ─── Сессии ───────────────────────────────────────────────────────────────
  route({
    route: 'GET /me/sessions',
    auth: 'session',
    tags: ['auth'],
    summary: 'Устройства и сессии',
    handler: async (request) => ({
      items: await AuthService.listSessions(request.ctx.userId, request.ctx.sessionId),
    }),
  })

  route({
    route: 'POST /me/sessions/revoke',
    auth: 'session',
    tags: ['auth'],
    summary: 'Завершить сессии',
    handler: async (request) => {
      const revoked = request.body.all
        ? await AuthService.revokeAllExcept(request.ctx.userId, request.ctx.sessionId)
        : await AuthService.revokeSessions(request.ctx, request.body.sessionIds ?? [])
      return { revoked }
    },
  })
}
