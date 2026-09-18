import type { SecurityPolicy } from '@kchs/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Политика безопасности (17-security.md §2, 05-risks N3; P0-E03 S02, P0-E06 S04):
 * обязательный второй фактор по ролям, запрет гостевых ссылок, простой сессии.
 */
registerLifecycle()

const { auditLog, sessions, users } = await import('../src/shared/db/schema/index.js')
const { authenticateSocket } = await import('../src/kernel/realtime/gateway.js')
const { AuthService } = await import('../src/modules/identity/public.js')

/** Подключение к realtime-шлюзу с cookie пользователя. */
const connect = (user: TestUser) =>
  authenticateSocket(
    user.cookie,
    { id: 'test-socket', ip: '127.0.0.1', headers: {} },
    { resolveSession: (token) => AuthService.resolveSession(token) },
  )

let fx: TestContext
const run = Date.now().toString(36)
const DEFAULTS: SecurityPolicy = {
  requireMfaRoles: [],
  allowShareLinks: true,
  sessionIdleHours: null,
}

beforeAll(async () => {
  fx = await setupFixture()
})

afterAll(async () => {
  await setPolicy(DEFAULTS)
})

async function setPolicy(patch: Partial<SecurityPolicy>): Promise<SecurityPolicy> {
  const response = await call(fx.app, {
    method: 'PATCH',
    url: '/admin/security-policy',
    as: fx.admin,
    payload: patch,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

async function createFolder(name: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id as string
}

describe('политика безопасности: администрирование', () => {
  it('по умолчанию MFA не обязательна, ссылки разрешены, простой — из конфигурации', async () => {
    const response = await call(fx.app, { url: '/admin/security-policy', as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(DEFAULTS)
  })

  it('читать и менять политику может только администратор системы', async () => {
    const read = await call(fx.app, { url: '/admin/security-policy', as: fx.users.member })
    expect(read.statusCode).toBe(403)
    const write = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/security-policy',
      as: fx.users.member,
      payload: { allowShareLinks: false },
    })
    expect(write.statusCode).toBe(403)
  })

  it('неизвестная роль отклоняется', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/security-policy',
      as: fx.admin,
      payload: { requireMfaRoles: ['security_auditor', 'no_such_role'] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('no_such_role')
  })

  it('изменение пишется в аудит с состоянием до и после', async () => {
    await setPolicy({ sessionIdleHours: 48 })
    const [entry] = await db()
      .select({ details: auditLog.details, severity: auditLog.severity })
      .from(auditLog)
      .where(eq(auditLog.action, 'security.policy_changed'))
      .orderBy(desc(auditLog.occurredAt))
      .limit(1)
    expect(entry?.severity).toBe('notice')
    expect(entry?.details).toMatchObject({
      before: { sessionIdleHours: null },
      after: { sessionIdleHours: 48 },
    })
    await setPolicy({ sessionIdleHours: null })
  })
})

describe('обязательный второй фактор по роли', () => {
  let auditor: TestUser

  beforeAll(async () => {
    auditor = await createUser(fx.app, `auditor_${run}`, ['security_auditor'])
    await setPolicy({ requireMfaRoles: ['security_auditor'] })
  })

  it('без второго фактора доступны только профиль и его подключение', async () => {
    const blocked = await call(fx.app, { url: '/spaces', as: auditor })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().code).toBe('mfa_enrollment_required')

    const me = await call(fx.app, { url: '/me', as: auditor })
    expect(me.statusCode).toBe(200)
    expect(me.json().mfaEnrollmentRequired).toBe(true)

    // Realtime тоже закрыт: иначе события объектов обошли бы ограничение
    await expect(connect(auditor)).rejects.toThrow('setup_required')

    // Сотрудника без этой роли политика не касается
    const member = await call(fx.app, { url: '/spaces', as: fx.users.member })
    expect(member.statusCode).toBe(200)
    await expect(connect(fx.users.member)).resolves.toMatchObject({ userId: fx.users.member.id })
  })

  it('после подключения TOTP доступ открыт, отключить второй фактор политика не даёт', async () => {
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: auditor })
    expect(setup.statusCode).toBe(200)
    // Ключ 160 бит (RFC 4226 §4): 32 символа base32
    expect(setup.json().secret).toMatch(/^[A-Z2-7]{32}$/)
    const enabled = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: auditor,
      payload: { code: authenticator.generate(setup.json().secret) },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().codes.length).toBeGreaterThan(0)

    expect((await call(fx.app, { url: '/spaces', as: auditor })).statusCode).toBe(200)
    expect((await call(fx.app, { url: '/me', as: auditor })).json().mfaEnrollmentRequired).toBe(
      false,
    )
    await expect(connect(auditor)).resolves.toMatchObject({ userId: auditor.id })

    const disable = await call(fx.app, {
      method: 'DELETE',
      url: '/me/mfa',
      as: auditor,
      payload: { code: enabled.json().codes[0] },
    })
    expect(disable.statusCode).toBe(422)
    expect(disable.json().code).toBe('policy_violation')
  })

  it('сначала смена временного пароля, затем второй фактор', async () => {
    const newcomer = await createUser(fx.app, `newcomer_${run}`, ['security_auditor'])
    await db().update(users).set({ mustChangePassword: true }).where(eq(users.id, newcomer.id))

    const first = await call(fx.app, { url: '/spaces', as: newcomer })
    expect(first.json().code).toBe('password_change_required')
    await expect(connect(newcomer)).rejects.toThrow('setup_required')

    const changed = await call(fx.app, {
      method: 'POST',
      url: '/me/password',
      as: newcomer,
      payload: {
        currentPassword: newcomer.password,
        newPassword: `Svoi-Parol-${run}-2026!`,
        revokeOtherSessions: false,
      },
    })
    expect(changed.statusCode, changed.body).toBe(200)

    const second = await call(fx.app, { url: '/spaces', as: newcomer })
    expect(second.statusCode).toBe(403)
    expect(second.json().code).toBe('mfa_enrollment_required')
  })

  it('снятие роли из политики снимает требование', async () => {
    const other = await createUser(fx.app, `auditor2_${run}`, ['security_auditor'])
    expect((await call(fx.app, { url: '/spaces', as: other })).statusCode).toBe(403)
    await setPolicy({ requireMfaRoles: [] })
    expect((await call(fx.app, { url: '/spaces', as: other })).statusCode).toBe(200)
  })
})

describe('гостевые ссылки и политика', () => {
  it('выключение запрещает создание и приостанавливает выданные ссылки', async () => {
    const folder = await createFolder(`Ссылки ${run}`)
    const created = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folder}/share-links`,
      as: fx.admin,
      payload: { level: 'view', includeAttachments: false },
    })
    expect(created.statusCode).toBe(200)
    const token = created.json().token as string
    const opened = await call(fx.app, { method: 'POST', url: `/share/${token}/open`, payload: {} })
    const grant = opened.json().accessToken as string
    const asGuest = { 'x-kchs-share-token': grant }
    expect((await call(fx.app, { url: `/objects/${folder}`, headers: asGuest })).statusCode).toBe(
      200,
    )

    await setPolicy({ allowShareLinks: false })

    const list = await call(fx.app, { url: `/objects/${folder}/share-links`, as: fx.admin })
    expect(list.json().allowed).toBe(false)
    expect(list.json().items).toHaveLength(1)

    const refused = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folder}/share-links`,
      as: fx.admin,
      payload: { level: 'view', includeAttachments: false },
    })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().code).toBe('policy_violation')

    const reopen = await call(fx.app, { method: 'POST', url: `/share/${token}/open`, payload: {} })
    expect(reopen.statusCode).toBe(404)
    const guestView = await call(fx.app, { url: `/objects/${folder}`, headers: asGuest })
    expect(guestView.statusCode).not.toBe(200)

    // Включение возвращает действие ссылок, которые не отзывали
    await setPolicy({ allowShareLinks: true })
    const again = await call(fx.app, { method: 'POST', url: `/share/${token}/open`, payload: {} })
    expect(again.statusCode).toBe(200)
  })
})

describe('простой сессии по политике', () => {
  it('сессия, простоявшая дольше срока политики, завершается', async () => {
    const idle = await createUser(fx.app, `idle_${run}`)
    expect((await call(fx.app, { url: '/me', as: idle })).statusCode).toBe(200)

    await setPolicy({ sessionIdleHours: 1 })
    await db()
      .update(sessions)
      .set({ lastActiveAt: sql`now() - interval '2 hours'` })
      .where(eq(sessions.userId, idle.id))

    expect((await call(fx.app, { url: '/me', as: idle })).statusCode).toBe(401)
    await setPolicy({ sessionIdleHours: null })
  })
})
