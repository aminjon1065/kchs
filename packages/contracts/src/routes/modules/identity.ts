import { z } from 'zod'
import { AdminModeInput, AdminModeState } from '../../access/confidentiality.js'
import { SecurityPolicy, SecurityPolicyPatch } from '../../admin/security.js'
import {
  UsersImportParsed,
  UsersImportStartInput,
  UsersImportStatus,
} from '../../admin/users-import.js'
import {
  PasskeyAuthenticationOptions,
  PasskeyInfo,
  PasskeyLoginInput,
  PasskeyRegisterInput,
  PasskeyRegistrationOptions,
} from '../../auth/passkeys.js'
import {
  LoginInput,
  MeResponse,
  MfaEnableInput,
  MfaSetupResponse,
  MfaVerifyInput,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  ProfileUpdateInput,
  RecoveryCodesResponse,
  SessionInfo,
} from '../../auth/session.js'
import { defineRoutes } from '../../http/route-contract.js'
import {
  DirectorySettingsInput,
  DirectoryState,
  DirectorySyncRun,
  DirectoryTestResult,
} from '../../integrations/directory.js'
import { AuthMethods, SsoSettingsInput, SsoState, SsoTestResult } from '../../integrations/sso.js'

const ImportParam = z.object({ importId: z.uuid() })

/**
 * Маршруты модуля «identity» (ADR-0188). Регистрация — `apps/api/src/modules/identity/http/`:
 * auth-routes.ts, directory-routes.ts, me-routes.ts, passkey-routes.ts, security-routes.ts,
 * sso-routes.ts, user-credential-routes.ts, users-import-routes.ts.
 */
export const identityRoutes = defineRoutes({
  'POST /auth/login': {
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
  'POST /auth/mfa/verify': {
    body: MfaVerifyInput,
    response: {
      200: z.object({
        status: z.enum(['ok', 'password_change_required']),
        csrfToken: z.string(),
      }),
    },
  },
  'POST /auth/logout': {
    response: {
      200: z.object({
        ok: z.boolean(),
        /** Куда отправить браузер, чтобы завершить и сессию IdP (ADR-0098). */
        endSessionUrl: z.url().nullable().default(null),
      }),
    },
  },
  'POST /auth/password-reset': {
    body: PasswordResetRequestInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /auth/password-reset/confirm': {
    body: PasswordResetConfirmInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /me/password': {
    body: PasswordChangeInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /me/mfa/setup': { response: { 200: MfaSetupResponse } },
  'POST /me/mfa/enable': { body: MfaEnableInput, response: { 200: RecoveryCodesResponse } },
  'DELETE /me/mfa': {
    body: z.object({ code: z.string().min(6).max(24) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /me/sessions': { response: { 200: z.object({ items: z.array(SessionInfo) }) } },
  'POST /me/sessions/revoke': {
    body: z.object({ sessionIds: z.array(z.uuid()).optional(), all: z.boolean().default(false) }),
    response: { 200: z.object({ revoked: z.number().int() }) },
  },
  'GET /admin/directory': { response: { 200: DirectoryState } },
  'PUT /admin/directory': { body: DirectorySettingsInput, response: { 200: DirectoryState } },
  'POST /admin/directory/test': { response: { 200: DirectoryTestResult } },
  'POST /admin/directory/preview': { response: { 200: DirectorySyncRun } },
  'POST /admin/directory/sync': { response: { 200: DirectorySyncRun } },
  'GET /admin/directory/syncs': {
    query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
    response: { 200: z.object({ items: z.array(DirectorySyncRun) }) },
  },
  'GET /me': { response: { 200: MeResponse } },
  'PATCH /me': { body: ProfileUpdateInput, response: { 200: z.object({ ok: z.boolean() }) } },
  'GET /me/preferences': {},
  'PUT /me/preferences': {
    body: z.object({ key: z.string().max(100), value: z.unknown() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /me/workspace-state': {},
  'PUT /me/workspace-state': {
    body: z.object({ state: z.unknown() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /me/admin-mode': { body: AdminModeInput, response: { 200: AdminModeState } },
  'DELETE /me/admin-mode': { response: { 200: z.object({ ok: z.boolean() }) } },
  'GET /me/delegations': {},
  'POST /me/delegations': {
    body: z.object({
      toUserId: z.uuid(),
      scope: z.enum(['all', 'approvals', 'instructions', 'documents', 'meetings']).default('all'),
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      note: z.string().max(500).nullable().optional(),
    }),
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'DELETE /me/delegations/:id': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /me/passkeys': { response: { 200: z.object({ items: z.array(PasskeyInfo) }) } },
  'POST /me/passkeys/options': { response: { 200: PasskeyRegistrationOptions } },
  'POST /me/passkeys': { body: PasskeyRegisterInput, response: { 200: PasskeyInfo } },
  'DELETE /me/passkeys/:keyId': {
    params: z.object({ keyId: z.string().min(1).max(1024) }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /auth/passkey/options': { response: { 200: PasskeyAuthenticationOptions } },
  'POST /auth/passkey/verify': {
    body: PasskeyLoginInput,
    response: { 200: z.object({ status: z.literal('ok'), csrfToken: z.string() }) },
  },
  'POST /auth/mfa/passkey/options': { response: { 200: PasskeyAuthenticationOptions } },
  'POST /auth/mfa/passkey/verify': {
    body: PasskeyLoginInput,
    response: {
      200: z.object({
        status: z.enum(['ok', 'password_change_required']),
        csrfToken: z.string(),
      }),
    },
  },
  'GET /admin/security-policy': { response: { 200: SecurityPolicy } },
  'PATCH /admin/security-policy': { body: SecurityPolicyPatch, response: { 200: SecurityPolicy } },
  'GET /auth/methods': { response: { 200: AuthMethods } },
  'POST /auth/sso/start': { response: { 200: z.object({ url: z.url() }) } },
  'GET /auth/sso/callback': {
    query: z
      .object({
        code: z.string().max(4096).optional(),
        state: z.string().max(512).optional(),
        error: z.string().max(200).optional(),
        error_description: z.string().max(500).optional(),
        iss: z.string().max(300).optional(),
      })
      .loose(),
  },
  'GET /admin/sso': { response: { 200: SsoState } },
  'PUT /admin/sso': { body: SsoSettingsInput, response: { 200: SsoState } },
  'POST /admin/sso/test': { response: { 200: SsoTestResult } },
  'POST /users/:id/reset-mfa': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /users/:id/passkeys': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ items: z.array(PasskeyInfo) }) },
  },
  'DELETE /users/:id/passkeys': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ revoked: z.number().int() }) },
  },
  'GET /admin/users/import/template.xlsx': {},
  'POST /admin/users/import': {
    body: UsersImportStartInput,
    response: { 202: z.object({ importId: z.uuid() }) },
  },
  'GET /admin/users/import/:importId': {
    params: ImportParam,
    response: { 200: UsersImportStatus },
  },
  'GET /admin/users/import/:importId/report.csv': { params: ImportParam },
  'GET /admin/users/import/:importId/credentials.csv': { params: ImportParam },
  'POST /internal/users-import/:importId/parsed': {
    params: ImportParam,
    body: UsersImportParsed,
    response: { 200: z.object({ applyJobId: z.uuid() }) },
  },
})
