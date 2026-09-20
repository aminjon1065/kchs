import {
  LoginInput,
  MfaEnableInput,
  MfaSetupResponse,
  MfaVerifyInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RecoveryCodesResponse,
  SessionInfo,
} from '@kchs/contracts'
import QRCode from 'qrcode'
import { z } from 'zod'
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
    method: 'POST',
    url: '/auth/login',
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
    schema: {
      body: LoginInput,
      response: {
        200: z.object({
          status: z.enum(['ok', 'mfa_required', 'password_change_required']),
          csrfToken: z.string().optional(),
          challengeId: z.string().optional(),
          expiresAt: z.string().optional(),
          /** Чем подтвердить второй фактор: код приложения, код восстановления, ключ. */
          methods: z.array(z.enum(['totp', 'recovery_code', 'passkey'])).optional(),
        }),
      },
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
    method: 'POST',
    url: '/auth/mfa/verify',
    auth: 'public',
    tags: ['auth'],
    summary: 'Подтверждение второго фактора',
    // По адресу и вызову входа; сам вызов допускает не больше 5 попыток
    rateLimit: {
      ...rateLimit(10, '1 minute'),
      keyGenerator: (request) => addressKey('mfa', request, request.cookies?.[MFA_COOKIE] ?? ''),
    },
    schema: {
      body: MfaVerifyInput,
      response: {
        200: z.object({
          status: z.enum(['ok', 'password_change_required']),
          csrfToken: z.string(),
        }),
      },
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
    method: 'POST',
    url: '/auth/logout',
    auth: 'session',
    allowPendingPasswordChange: true,
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Выход',
    schema: {
      response: {
        200: z.object({
          ok: z.boolean(),
          /** Куда отправить браузер, чтобы завершить и сессию IdP (ADR-0098). */
          endSessionUrl: z.url().nullable().default(null),
        }),
      },
    },
    handler: async (request, reply) => {
      await AuthService.logout(request.ctx)
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      return { ok: true, endSessionUrl: await SsoService.endSessionUrl() }
    },
  })

  route({
    method: 'POST',
    url: '/auth/password-reset',
    auth: 'public',
    tags: ['auth'],
    summary: 'Запрос восстановления доступа',
    // Письма одному адресату — не чаще 5 за 10 минут; с одного адреса — не больше 50
    rateLimit: {
      ...rateLimit(5, '10 minutes'),
      keyGenerator: (request) =>
        addressKey('reset', request, (request.body as { login?: string } | undefined)?.login ?? ''),
    },
    schema: { body: PasswordResetRequestInput, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await enforceAddressCeiling('reset-ip', request, 50, 600)
      const result = await AuthService.requestPasswordReset(request.body.login)
      if (result) await sendPasswordReset(result.userId, result.token)
      // Ответ одинаков вне зависимости от существования учётной записи
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/auth/password-reset/confirm',
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
    schema: { body: PasswordResetConfirmInput, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await AuthService.confirmPasswordReset(request.body.token, request.body.newPassword)
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/me/password',
    auth: 'session',
    allowPendingPasswordChange: true,
    tags: ['auth'],
    summary: 'Смена пароля',
    schema: { body: PasswordChangeInput, response: { 200: z.object({ ok: z.boolean() }) } },
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
    method: 'POST',
    url: '/me/mfa/setup',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Начать подключение TOTP',
    schema: { response: { 200: MfaSetupResponse } },
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
    method: 'POST',
    url: '/me/mfa/enable',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['auth'],
    summary: 'Подтвердить и включить TOTP',
    schema: { body: MfaEnableInput, response: { 200: RecoveryCodesResponse } },
    handler: async (request) => ({
      codes: await AuthService.enableMfa(request.ctx, request.body.code),
    }),
  })

  route({
    method: 'DELETE',
    url: '/me/mfa',
    auth: 'session',
    tags: ['auth'],
    summary: 'Отключить TOTP',
    schema: {
      body: z.object({ code: z.string().min(6).max(24) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
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
    method: 'GET',
    url: '/me/sessions',
    auth: 'session',
    tags: ['auth'],
    summary: 'Устройства и сессии',
    schema: { response: { 200: z.object({ items: z.array(SessionInfo) }) } },
    handler: async (request) => ({
      items: await AuthService.listSessions(request.ctx.userId, request.ctx.sessionId),
    }),
  })

  route({
    method: 'POST',
    url: '/me/sessions/revoke',
    auth: 'session',
    tags: ['auth'],
    summary: 'Завершить сессии',
    schema: {
      body: z.object({ sessionIds: z.array(z.uuid()).optional(), all: z.boolean().default(false) }),
      response: { 200: z.object({ revoked: z.number().int() }) },
    },
    handler: async (request) => {
      const revoked = request.body.all
        ? await AuthService.revokeAllExcept(request.ctx.userId, request.ctx.sessionId)
        : await AuthService.revokeSessions(request.ctx, request.body.sessionIds ?? [])
      return { revoked }
    },
  })
}
