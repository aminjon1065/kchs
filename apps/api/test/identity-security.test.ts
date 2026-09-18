import { sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { authenticator } from 'otplib'
import { beforeAll, describe, expect, it } from 'vitest'
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
 * Безопасность идентификации (17-security.md §2): регрессии по ревью —
 * повышение привилегий, захват учётной записи через сброс, временный пароль,
 * подмена IP, гостевой токен, повтор TOTP.
 */
registerLifecycle()

const PASSWORD = 'Test!Password-2026-x'
let fx: TestContext
let orgAdmin: TestUser

beforeAll(async () => {
  fx = await setupFixture()
  orgAdmin = await createUser(fx.app, 'orgadmin_test', ['org_admin'])
})

async function roleKeysOf(userId: string): Promise<string[]> {
  const rows = await db().execute<{ key: string }>(
    sql`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${userId}`,
  )
  return rows.map((r) => r.key).sort()
}

function cookieOf(response: { headers: Record<string, unknown> }, name: string): string {
  return (
    String(response.headers['set-cookie'])
      .split(/[;,]/)
      .find((part) => part.trim().startsWith(`${name}=`))
      ?.trim() ?? ''
  )
}

describe('роли и управление учётными записями', () => {
  it('администратор оргструктуры не повышает себя до администратора системы', async () => {
    const self = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${orgAdmin.id}`,
      as: orgAdmin,
      payload: { roleKeys: ['org_admin', 'system_admin'] },
    })
    expect(self.statusCode).toBe(403)
    expect(await roleKeysOf(orgAdmin.id)).toEqual(['org_admin'])

    const other = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${fx.users.member.id}`,
      as: orgAdmin,
      payload: { roleKeys: ['system_admin'] },
    })
    expect(other.statusCode).toBe(403)

    const created = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: orgAdmin,
      payload: {
        login: 'escalated_test',
        lastName: 'Эскалация',
        firstName: 'Тест',
        roleKeys: ['system_admin'],
      },
    })
    expect(created.statusCode).toBe(403)
  })

  it('администратор оргструктуры заводит сотрудников на базовой роли', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: orgAdmin,
      payload: { login: 'newcomer_test', lastName: 'Новиков', firstName: 'Тест' },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().temporaryPassword).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(await roleKeysOf(created.json().id)).toEqual(['employee'])

    const unknown = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: fx.admin,
      payload: { login: 'ghost_test', lastName: 'Призрак', firstName: 'Тест', roleKeys: ['nope'] },
    })
    expect(unknown.statusCode).toBe(400)
  })

  it('сброс пароля и MFA администратора системы — только администратору системы', async () => {
    for (const url of [`/users/${fx.admin.id}/reset-password`, `/users/${fx.admin.id}/reset-mfa`]) {
      const response = await call(fx.app, { method: 'POST', url, as: orgAdmin })
      expect(response.statusCode, url).toBe(403)
    }
    const block = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${fx.admin.id}`,
      as: orgAdmin,
      payload: { status: 'blocked' },
    })
    expect(block.statusCode).toBe(403)
  })

  it('свои роли меняет другой администратор, последний активный — неприкосновенен', async () => {
    const self = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${fx.admin.id}`,
      as: fx.admin,
      payload: { roleKeys: ['employee'] },
    })
    expect(self.statusCode).toBe(403)

    const second = await createUser(fx.app, 'admin2_test', ['system_admin'])
    const demote = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${fx.admin.id}`,
      as: second,
      payload: { roleKeys: ['employee'] },
    })
    expect(demote.statusCode).toBe(200)
    const restore = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${fx.admin.id}`,
      as: second,
      payload: { roleKeys: ['system_admin'] },
    })
    expect(restore.statusCode).toBe(200)

    // Вне HTTP (системный контекст, CLI) страхует проверка последнего администратора
    await db().execute(sql`UPDATE users SET status = 'blocked' WHERE id = ${second.id}`)
    const { assertNotLastSystemAdmin } = await import(
      '../src/modules/identity/domain/role-policy.js'
    )
    await expect(assertNotLastSystemAdmin(db(), fx.admin.id)).rejects.toThrow('последнего')
    await db().execute(sql`UPDATE users SET status = 'active' WHERE id = ${second.id}`)
  })

  it('смена ролей действует со следующего запроса, без ожидания кэша', async () => {
    const deputy = await createUser(fx.app, 'deputy_admin_test', ['org_admin'])
    const canList = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: deputy,
      payload: { login: 'probe_one_test', lastName: 'Проба', firstName: 'Тест' },
    })
    expect(canList.statusCode).toBe(200)

    const demoted = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${deputy.id}`,
      as: fx.admin,
      payload: { roleKeys: ['employee'] },
    })
    expect(demoted.statusCode).toBe(200)

    const after = await call(fx.app, {
      method: 'POST',
      url: '/users',
      as: deputy,
      payload: { login: 'probe_two_test', lastName: 'Проба', firstName: 'Тест' },
    })
    expect(after.statusCode).toBe(403)
  })
})

describe('временный пароль', () => {
  it('до смены временного пароля доступны только профиль, смена пароля и выход', async () => {
    const employee = await createUser(fx.app, 'temp_pass_test', ['employee'])
    const reset = await call(fx.app, {
      method: 'POST',
      url: `/users/${employee.id}/reset-password`,
      as: orgAdmin,
    })
    expect(reset.statusCode).toBe(200)
    const temporary = reset.json().temporaryPassword as string
    expect(temporary).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const login = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: employee.login, password: temporary },
    })
    expect(login.json().status).toBe('password_change_required')
    const session: TestUser = {
      ...employee,
      cookie: cookieOf(login, 'kchs_session'),
      csrf: login.json().csrfToken,
    }

    const me = await call(fx.app, { url: '/me', as: session })
    expect(me.statusCode).toBe(200)
    expect(me.json().mustChangePassword).toBe(true)

    const inbox = await call(fx.app, { url: '/inbox', as: session })
    expect(inbox.statusCode).toBe(403)
    expect(inbox.json().code).toBe('password_change_required')

    const change = await call(fx.app, {
      method: 'POST',
      url: '/me/password',
      as: session,
      payload: {
        currentPassword: temporary,
        newPassword: 'New!Password-2026-q',
        revokeOtherSessions: false,
      },
    })
    expect(change.statusCode).toBe(200)
    expect((await call(fx.app, { url: '/inbox', as: session })).statusCode).toBe(200)
  })
})

describe('вход и второй фактор', () => {
  it('код TOTP нельзя предъявить повторно', async () => {
    const user = await createUser(fx.app, 'totp_replay_test', ['employee'])
    const setup = await call(fx.app, { method: 'POST', url: '/me/mfa/setup', as: user })
    const secret = setup.json().secret as string
    const now = authenticator.generate(secret)
    const enable = await call(fx.app, {
      method: 'POST',
      url: '/me/mfa/enable',
      as: user,
      payload: { code: now },
    })
    expect(enable.statusCode).toBe(200)

    async function loginWith(code: string) {
      const first = await call(fx.app, {
        method: 'POST',
        url: '/auth/login',
        payload: { login: user.login, password: PASSWORD },
      })
      return call(fx.app, {
        method: 'POST',
        url: '/auth/mfa/verify',
        headers: { cookie: cookieOf(first, 'kchs_mfa') },
        payload: { challengeId: first.json().challengeId, code },
      })
    }

    // Тот же код, которым только что включили MFA, — повтор
    expect((await loginWith(now)).statusCode).toBe(401)
    // Код следующего шага (окно ±1) принимается один раз
    const next = authenticator.clone({ epoch: Date.now() + 30_000 }).generate(secret)
    expect((await loginWith(next)).statusCode).toBe(200)
    expect((await loginWith(next)).statusCode).toBe(401)
  })

  it('о блокировке узнаёт только тот, кто знает пароль', async () => {
    const user = await createUser(fx.app, 'lockout_test', ['employee'])
    await db().execute(
      sql`UPDATE credentials SET locked_until = now() + interval '15 minutes' WHERE user_id = ${user.id}`,
    )
    const wrong = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: user.login, password: 'неверный-пароль' },
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json().detail ?? wrong.json().title).not.toContain('заблокирована')

    const right = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: user.login, password: PASSWORD },
    })
    expect(right.statusCode).toBe(401)
    expect(JSON.stringify(right.json())).toContain('заблокирована')
  })

  it('новый пароль не может содержать логин — ни при смене, ни при восстановлении', async () => {
    const user = await createUser(fx.app, 'login_in_password_test', ['employee'])
    const changed = await call(fx.app, {
      method: 'POST',
      url: '/me/password',
      as: user,
      payload: {
        currentPassword: user.password,
        newPassword: `Login_In_Password_Test-2026!`,
        revokeOtherSessions: false,
      },
    })
    expect(changed.statusCode).toBe(400)
    expect(changed.body).toContain('auth.password.containsLogin')

    const { AuthService } = await import('../src/modules/identity/public.js')
    const request = await AuthService.requestPasswordReset(user.login)
    const reset = await call(fx.app, {
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token: request?.token, newPassword: `x-${user.login}-Pass-2026!` },
    })
    expect(reset.statusCode).toBe(400)
    expect(reset.body).toContain('auth.password.containsLogin')
  })

  it('ссылка восстановления не возвращает доступ отключённой учётной записи', async () => {
    const user = await createUser(fx.app, 'reset_blocked_test', ['employee'])
    const { AuthService } = await import('../src/modules/identity/public.js')
    const request = await AuthService.requestPasswordReset(user.login)
    expect(request).not.toBeNull()
    await db().execute(sql`UPDATE users SET status = 'blocked' WHERE id = ${user.id}`)
    const confirm = await call(fx.app, {
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token: request?.token, newPassword: 'Another!Password-2026' },
    })
    expect(confirm.statusCode).toBe(400)
  })

  it('X-Forwarded-For от недоверенного адреса не подменяет IP клиента', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.20.30.40',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { login: 'nobody-at-all', password: 'x' },
    })
    expect(response.statusCode).toBe(401)
    const rows = await db().execute<{ ip: string }>(
      sql`SELECT ip FROM audit_log WHERE action = 'user.login_failed'
           AND details->>'login' = 'nobody-at-all' ORDER BY id DESC LIMIT 1`,
    )
    expect(rows[0]?.ip).toBe('10.20.30.40')
  })

  it('TRUST_PROXY=true отклоняется конфигурацией', async () => {
    const { loadEnv } = await import('../src/shared/config/env.js')
    expect(() => loadEnv({ ...process.env, TRUST_PROXY: 'true' })).toThrow('TRUST_PROXY')
  })
})

describe('частота входа за NAT организации', () => {
  it('подбор пароля считается по адресу и логину: коллеги с того же адреса входят', async () => {
    const { addressKey } = await import('../src/shared/http/rate-limit.js')
    const from = (ip: string) => ({ ip }) as FastifyRequest
    const key = addressKey('login', from('10.0.0.1'), ' Ivanov ')
    expect(addressKey('login', from('10.0.0.1'), 'ivanov')).toBe(key)
    expect(addressKey('login', from('10.0.0.1'), 'petrov')).not.toBe(key)
    expect(addressKey('login', from('10.0.0.2'), 'ivanov')).not.toBe(key)
    expect(addressKey('reset', from('10.0.0.1'), 'ivanov')).not.toBe(key)
    // В Redis не остаются логины
    expect(key).not.toContain('ivanov')
  })

  it('потолок адреса — фиксированное окно, которое истекает', async () => {
    const { hitRateLimit } = await import('../src/shared/http/rate-limit.js')
    const { cacheKeys, redis } = await import('../src/shared/redis/index.js')
    const bucket = `ceiling-${Date.now()}`
    for (let i = 0; i < 3; i++) {
      expect((await hitRateLimit(bucket, '10.0.0.1', 3, 60)).allowed).toBe(true)
    }
    const denied = await hitRateLimit(bucket, '10.0.0.1', 3, 60)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfter).toBeGreaterThan(0)
    expect(denied.retryAfter).toBeLessThanOrEqual(60)
    expect((await hitRateLimit(bucket, '10.0.0.2', 3, 60)).allowed).toBe(true)
    // Окно не продлевается запросами и не остаётся вечным ключом
    const ttl = await redis().ttl(cacheKeys.rateLimit(bucket, '10.0.0.1'))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(60)
  })
})

describe('гостевой токен', () => {
  it('гость по ссылке только читает свой объект', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Для гостя', spaceId: fx.spaceId },
    })
    const folderId = folder.json().id as string
    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: fx.admin,
      payload: { level: 'view', includeAttachments: false },
    })
    expect(link.statusCode).toBe(200)
    const guest = { 'x-kchs-share-token': link.json().token as string }

    expect((await call(fx.app, { url: `/objects/${folderId}`, headers: guest })).statusCode).toBe(
      200,
    )
    for (const request of [
      { method: 'GET' as const, url: '/me' },
      { method: 'GET' as const, url: '/inbox' },
      { method: 'PUT' as const, url: '/me/preferences', payload: { theme: 'dark' } },
      { method: 'PUT' as const, url: `/objects/${folderId}/favorite` },
      { method: 'PATCH' as const, url: `/objects/${folderId}`, payload: { title: 'гость' } },
    ]) {
      const response = await call(fx.app, { ...request, headers: guest })
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404)
    }
  })

  it('ссылку с лимитом открытий нельзя предъявить напрямую, минуя счётчик', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Лимит открытий', spaceId: fx.spaceId },
    })
    const folderId = folder.json().id as string
    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: fx.admin,
      payload: { level: 'view', maxUses: 1, includeAttachments: false },
    })
    expect(link.statusCode).toBe(200)
    const raw = await call(fx.app, {
      url: `/objects/${folderId}`,
      headers: { 'x-kchs-share-token': link.json().token },
    })
    expect(raw.statusCode).toBe(401)

    const open = await call(fx.app, {
      method: 'POST',
      url: `/share/${link.json().token}/open`,
      payload: {},
    })
    expect(open.statusCode).toBe(200)
    const again = await call(fx.app, {
      method: 'POST',
      url: `/share/${link.json().token}/open`,
      payload: {},
    })
    expect(again.statusCode).toBe(404)
  })
})
