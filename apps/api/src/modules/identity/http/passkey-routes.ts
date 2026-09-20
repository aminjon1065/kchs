import {
  PasskeyAuthenticationOptions,
  PasskeyInfo,
  PasskeyLoginInput,
  PasskeyRegisterInput,
  PasskeyRegistrationOptions,
} from '@kchs/contracts'
import { z } from 'zod'
import { addressKey, rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { PasskeyService } from '../domain/passkeys.js'
import { MFA_COOKIE, setSessionCookie } from './session-cookie.js'

/**
 * Ключи входа (ADR-0098): регистрация в профиле, самостоятельный вход и
 * подтверждение второго фактора поверх входа по паролю.
 *
 * Регистрация доступна и при незакрытом требовании второго фактора: ключ —
 * такой же второй фактор, как код приложения (17-security.md §2).
 */
export function registerPasskeyRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/me/passkeys',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['me'],
    summary: 'Мои ключи входа',
    schema: { response: { 200: z.object({ items: z.array(PasskeyInfo) }) } },
    handler: async (request) => ({ items: await PasskeyService.list(request.ctx.userId) }),
  })

  route({
    method: 'POST',
    url: '/me/passkeys/options',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['me'],
    summary: 'Параметры регистрации ключа',
    schema: { response: { 200: PasskeyRegistrationOptions } },
    handler: async (request) => PasskeyService.registrationOptions(request.ctx),
  })

  route({
    method: 'POST',
    url: '/me/passkeys',
    auth: 'session',
    allowPendingMfaEnrollment: true,
    tags: ['me'],
    summary: 'Добавить ключ входа',
    schema: { body: PasskeyRegisterInput, response: { 200: PasskeyInfo } },
    handler: async (request) =>
      PasskeyService.register(request.ctx, request.body.name, request.body.credential),
  })

  route({
    method: 'DELETE',
    url: '/me/passkeys/:keyId',
    auth: 'session',
    tags: ['me'],
    summary: 'Отозвать ключ входа',
    schema: {
      params: z.object({ keyId: z.string().min(1).max(1024) }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await PasskeyService.remove(request.ctx, request.params.keyId)
      return { ok: true }
    },
  })

  // ─── Вход по ключу ────────────────────────────────────────────────────────
  route({
    method: 'POST',
    url: '/auth/passkey/options',
    auth: 'public',
    tags: ['auth'],
    summary: 'Параметры входа по ключу',
    rateLimit: {
      ...rateLimit(20, '1 minute'),
      keyGenerator: (request) => addressKey('passkey-options', request, ''),
    },
    schema: { response: { 200: PasskeyAuthenticationOptions } },
    handler: async () => PasskeyService.loginOptions(),
  })

  route({
    method: 'POST',
    url: '/auth/passkey/verify',
    auth: 'public',
    tags: ['auth'],
    summary: 'Вход по ключу',
    rateLimit: {
      ...rateLimit(20, '1 minute'),
      keyGenerator: (request) => addressKey('passkey-verify', request, ''),
    },
    schema: {
      body: PasskeyLoginInput,
      response: { 200: z.object({ status: z.literal('ok'), csrfToken: z.string() }) },
    },
    handler: async (request, reply) => {
      const result = await PasskeyService.login(request.body.credential, {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      })
      setSessionCookie(reply, result.sessionToken, result.expiresAt)
      return { status: 'ok' as const, csrfToken: result.csrfToken }
    },
  })

  // ─── Ключ как второй фактор ───────────────────────────────────────────────
  route({
    method: 'POST',
    url: '/auth/mfa/passkey/options',
    auth: 'public',
    tags: ['auth'],
    summary: 'Параметры подтверждения ключом',
    rateLimit: {
      ...rateLimit(20, '1 minute'),
      keyGenerator: (request) => addressKey('mfa-passkey', request, ''),
    },
    schema: { response: { 200: PasskeyAuthenticationOptions } },
    handler: async (request, reply) => {
      const challengeToken = request.cookies?.[MFA_COOKIE]
      if (!challengeToken) {
        return reply
          .status(401)
          .send({ code: 'unauthorized', title: 'Войдите заново', status: 401 })
      }
      return PasskeyService.mfaOptions(challengeToken)
    },
  })

  route({
    method: 'POST',
    url: '/auth/mfa/passkey/verify',
    auth: 'public',
    tags: ['auth'],
    summary: 'Подтверждение второго фактора ключом',
    rateLimit: {
      ...rateLimit(20, '1 minute'),
      keyGenerator: (request) => addressKey('mfa-passkey-verify', request, ''),
    },
    schema: {
      body: PasskeyLoginInput,
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
      const result = await PasskeyService.mfaVerify(challengeToken, request.body.credential, {
        ip: request.ip ?? null,
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        requestId: request.id,
      })
      reply.clearCookie(MFA_COOKIE, { path: '/' })
      setSessionCookie(reply, result.sessionToken, result.expiresAt)
      return {
        status: result.mustChangePassword ? ('password_change_required' as const) : ('ok' as const),
        csrfToken: result.csrfToken,
      }
    },
  })
}
