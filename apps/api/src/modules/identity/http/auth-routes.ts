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
import { config } from '~/shared/config/index.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AuthService } from '../domain/auth-service.js'
import { sendPasswordReset } from '../domain/notify.js'

const MFA_COOKIE = 'kchs_mfa'

export function registerAuthRoutes(route: RouteRegistrar): void {
  const env = config()
  const secure = env.NODE_ENV === 'production'

  route({
    method: 'POST',
    url: '/auth/login',
    auth: 'public',
    tags: ['auth'],
    summary: 'Вход по логину и паролю',
    rateLimit: rateLimit(10, '1 minute'),
    schema: {
      body: LoginInput,
      response: {
        200: z.object({
          status: z.enum(['ok', 'mfa_required', 'password_change_required']),
          csrfToken: z.string().optional(),
          challengeId: z.string().optional(),
          expiresAt: z.string().optional(),
        }),
      },
    },
    handler: async (request, reply) => {
      const meta = {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      }
      const result = await AuthService.login(request.body.login, request.body.password, meta)

      if (result.status === 'mfa_required') {
        reply.setCookie(MFA_COOKIE, result.challengeToken, {
          httpOnly: true,
          secure,
          sameSite: 'lax',
          path: '/',
          maxAge: 600,
        })
        return {
          status: 'mfa_required',
          challengeId: result.challengeId,
          expiresAt: result.expiresAt,
        }
      }

      setSessionCookie(reply, result.sessionToken, result.expiresAt, secure)
      return { status: result.status, csrfToken: result.csrfToken, expiresAt: result.expiresAt }
    },
  })

  route({
    method: 'POST',
    url: '/auth/mfa/verify',
    auth: 'public',
    tags: ['auth'],
    summary: 'Подтверждение второго фактора',
    rateLimit: rateLimit(10, '1 minute'),
    schema: {
      body: MfaVerifyInput,
      response: { 200: z.object({ status: z.literal('ok'), csrfToken: z.string() }) },
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
      setSessionCookie(reply, result.sessionToken, result.expiresAt, secure)
      return { status: 'ok' as const, csrfToken: result.csrfToken }
    },
  })

  route({
    method: 'POST',
    url: '/auth/logout',
    auth: 'session',
    tags: ['auth'],
    summary: 'Выход',
    schema: { response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request, reply) => {
      await AuthService.logout(request.ctx)
      reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' })
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/auth/password-reset',
    auth: 'public',
    tags: ['auth'],
    summary: 'Запрос восстановления доступа',
    rateLimit: rateLimit(5, '10 minutes'),
    schema: { body: PasswordResetRequestInput, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
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
    rateLimit: rateLimit(10, '10 minutes'),
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
    tags: ['auth'],
    summary: 'Начать подключение TOTP',
    schema: { response: { 200: MfaSetupResponse } },
    handler: async (request) => {
      const { secret, otpauthUrl } = await AuthService.startMfaSetup(request.ctx)
      const qrSvg = await QRCode.toString(otpauthUrl, {
        type: 'svg',
        margin: 0,
        width: 200,
        color: { dark: '#17181C', light: '#00000000' },
      })
      return { secret, otpauthUrl, qrSvg }
    },
  })

  route({
    method: 'POST',
    url: '/me/mfa/enable',
    auth: 'session',
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

function setSessionCookie(
  reply: { setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown },
  token: string,
  expiresAt: string,
  secure: boolean,
): void {
  reply.setCookie(config().SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  })
}
