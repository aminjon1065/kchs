import type { PasskeyInfo } from '@kchs/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { FakeAuthenticator } from './fake-authenticator.js'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Ключи входа (passkeys, WebAuthn — P5-E04, ADR-0098): регистрация в профиле,
 * самостоятельный вход, второй фактор и отзыв. Устройство поддельное, но
 * подписи настоящие — их проверяет `@simplewebauthn/server`.
 */
registerLifecycle()

const { config } = await import('../src/shared/config/index.js')
const { SecurityPolicyService } = await import('../src/kernel/settings/security-policy.js')

const PASSWORD = 'Test!Password-2026-x'

let fx: TestContext
let rpId = ''
let origin = ''

beforeAll(async () => {
  fx = await setupFixture()
  const base = new URL(config().KCHS_BASE_URL)
  rpId = base.hostname
  origin = base.origin
})

function cookieOf(raw: unknown, name: string): string {
  const parts = Array.isArray(raw) ? raw : [String(raw)]
  for (const part of parts) {
    const value = String(part)
      .split(';')
      .find((item) => item.trim().startsWith(`${name}=`))
    if (value?.includes(`${name}=`) && !value.trim().endsWith(`${name}=`)) return value.trim()
  }
  return ''
}

/** Регистрация ключа в профиле: параметры → ответ устройства → сохранение. */
async function addKey(
  as: TestUser,
  device: FakeAuthenticator,
  name = 'Ноутбук',
): Promise<PasskeyInfo> {
  const options = await call(fx.app, { method: 'POST', url: '/me/passkeys/options', as })
  expect(options.statusCode).toBe(200)
  const credential = device.register(options.json().challenge, origin, rpId)
  const saved = await call(fx.app, {
    method: 'POST',
    url: '/me/passkeys',
    as,
    payload: { name, credential },
  })
  expect(saved.statusCode).toBe(200)
  return saved.json<PasskeyInfo>()
}

/** Самостоятельный вход по ключу. */
async function loginWithKey(device: FakeAuthenticator, userHandle: string) {
  const options = await call(fx.app, { method: 'POST', url: '/auth/passkey/options' })
  expect(options.statusCode).toBe(200)
  const credential = device.authenticate(options.json().challenge, origin, rpId, userHandle)
  return call(fx.app, { method: 'POST', url: '/auth/passkey/verify', payload: { credential } })
}

describe('ключи входа: профиль', () => {
  it('ключ добавляется и виден в списке, отзывается и исчезает', async () => {
    const user = await createUser(fx.app, 'passkey_profile', ['employee'])
    const device = new FakeAuthenticator()
    const added = await addKey(user, device, 'Рабочий ноутбук')
    expect(added.name).toBe('Рабочий ноутбук')
    expect(added.userVerified).toBe(true)

    const list = await call(fx.app, { url: '/me/passkeys', as: user })
    expect(list.json().items).toHaveLength(1)
    expect(list.json().items[0].id).toBe(added.id)

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/me/passkeys/${encodeURIComponent(added.id)}`,
      as: user,
    })
    expect(removed.statusCode).toBe(200)
    const after = await call(fx.app, { url: '/me/passkeys', as: user })
    expect(after.json().items).toHaveLength(0)
  })

  it('чужой ключ отозвать нельзя', async () => {
    const owner = await createUser(fx.app, 'passkey_owner', ['employee'])
    const stranger = await createUser(fx.app, 'passkey_stranger', ['employee'])
    const added = await addKey(owner, new FakeAuthenticator())
    const response = await call(fx.app, {
      method: 'DELETE',
      url: `/me/passkeys/${encodeURIComponent(added.id)}`,
      as: stranger,
    })
    expect(response.statusCode).toBe(404)
    expect((await call(fx.app, { url: '/me/passkeys', as: owner })).json().items).toHaveLength(1)
  })

  it('ключ засчитывается как второй фактор в профиле', async () => {
    const user = await createUser(fx.app, 'passkey_mfa_flag', ['employee'])
    expect((await call(fx.app, { url: '/me', as: user })).json().mfaEnabled).toBe(false)
    await addKey(user, new FakeAuthenticator())
    expect((await call(fx.app, { url: '/me', as: user })).json().mfaEnabled).toBe(true)
  })

  it('один и тот же ключ дважды не добавляется', async () => {
    const user = await createUser(fx.app, 'passkey_twice', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)
    const options = await call(fx.app, { method: 'POST', url: '/me/passkeys/options', as: user })
    const credential = device.register(options.json().challenge, origin, rpId)
    const again = await call(fx.app, {
      method: 'POST',
      url: '/me/passkeys',
      as: user,
      payload: { name: 'Он же', credential },
    })
    expect(again.statusCode).toBe(409)
  })
})

describe('ключи входа: самостоятельный вход', () => {
  it('вход по ключу создаёт сессию', async () => {
    const user = await createUser(fx.app, 'passkey_login', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)

    const response = await loginWithKey(device, user.id)
    expect(response.statusCode).toBe(200)
    const cookie = cookieOf(response.headers['set-cookie'], 'kchs_session')
    expect(cookie).toBeTruthy()
    const me = await call(fx.app, { url: '/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.login).toBe('passkey_login')
  })

  it('отозванный ключ не пускает', async () => {
    const user = await createUser(fx.app, 'passkey_revoked', ['employee'])
    const device = new FakeAuthenticator()
    const added = await addKey(user, device)
    await call(fx.app, {
      method: 'DELETE',
      url: `/me/passkeys/${encodeURIComponent(added.id)}`,
      as: user,
    })
    const response = await loginWithKey(device, user.id)
    expect(response.statusCode).toBe(401)
  })

  it('администратор видит ключи сотрудника и отзывает все; посторонний — нет (N45)', async () => {
    const user = await createUser(fx.app, `passkey_lost_${Date.now().toString(36)}`, ['employee'])
    const phone = new FakeAuthenticator()
    const token = new FakeAuthenticator()
    await addKey(user, phone, 'Телефон')
    await addKey(user, token, 'Ключ безопасности')

    const listed = await call(fx.app, { url: `/users/${user.id}/passkeys`, as: fx.admin })
    expect(listed.statusCode, listed.body).toBe(200)
    expect((listed.json().items as PasskeyInfo[]).map((item) => item.name).sort()).toEqual([
      'Ключ безопасности',
      'Телефон',
    ])

    // Рядовой сотрудник чужие ключи не видит и не отзывает
    expect(
      (await call(fx.app, { url: `/users/${user.id}/passkeys`, as: fx.users.member })).statusCode,
    ).toBe(403)
    expect(
      (
        await call(fx.app, {
          method: 'DELETE',
          url: `/users/${user.id}/passkeys`,
          as: fx.users.member,
        })
      ).statusCode,
    ).toBe(403)

    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/users/${user.id}/passkeys`,
      as: fx.admin,
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(revoked.json().revoked).toBe(2)
    expect((await loginWithKey(phone, user.id)).statusCode).toBe(401)
    expect((await loginWithKey(token, user.id)).statusCode).toBe(401)

    const audit = await call(fx.app, {
      url: `/admin/audit?action=user.passkeys_revoked&limit=5`,
      as: fx.admin,
    })
    expect(audit.statusCode, audit.body).toBe(200)
    expect(
      (audit.json().items as Array<{ objectId: string | null }>).some(
        (item) => item.objectId === user.id,
      ),
    ).toBe(true)
  })

  it('повторный ответ с тем же вызовом не принимается', async () => {
    const user = await createUser(fx.app, 'passkey_replay', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)

    const options = await call(fx.app, { method: 'POST', url: '/auth/passkey/options' })
    const challenge = options.json().challenge as string
    const credential = device.authenticate(challenge, origin, rpId, user.id)
    const first = await call(fx.app, {
      method: 'POST',
      url: '/auth/passkey/verify',
      payload: { credential },
    })
    expect(first.statusCode).toBe(200)
    const second = await call(fx.app, {
      method: 'POST',
      url: '/auth/passkey/verify',
      payload: { credential },
    })
    expect(second.statusCode).toBe(401)
  })

  it('чужой вызов (не выданный сервером) не принимается', async () => {
    const user = await createUser(fx.app, 'passkey_foreign', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)
    const credential = device.authenticate('придуманный-вызов', origin, rpId, user.id)
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/passkey/verify',
      payload: { credential },
    })
    expect(response.statusCode).toBe(401)
  })

  it('чужой адрес сайта в ответе устройства не принимается', async () => {
    const user = await createUser(fx.app, 'passkey_origin', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)
    const options = await call(fx.app, { method: 'POST', url: '/auth/passkey/options' })
    const credential = device.authenticate(
      options.json().challenge,
      'https://phishing.example',
      rpId,
      user.id,
    )
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/passkey/verify',
      payload: { credential },
    })
    expect(response.statusCode).toBe(401)
  })

  it('ключ без подтверждения личности самостоятельно не входит', async () => {
    const user = await createUser(fx.app, 'passkey_nouv', ['employee'])
    const device = new FakeAuthenticator({ userVerified: false })
    const added = await addKey(user, device)
    expect(added.userVerified).toBe(false)
    const response = await loginWithKey(device, user.id)
    expect(response.statusCode).toBe(401)
  })

  it('отключённая учётная запись по ключу не входит', async () => {
    const user = await createUser(fx.app, 'passkey_blocked', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${user.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(patch.statusCode).toBe(200)
    const response = await loginWithKey(device, user.id)
    expect(response.statusCode).toBe(401)
  })

  it('экран входа узнаёт о ключах установки', async () => {
    const response = await call(fx.app, { url: '/auth/methods' })
    expect(response.statusCode).toBe(200)
    expect(response.json().password).toBe(true)
    expect(response.json().passkeys).toBe(true)
  })
})

describe('ключи входа: второй фактор', () => {
  it('после пароля вход подтверждается ключом', async () => {
    const user = await createUser(fx.app, 'passkey_second', ['employee'])
    const device = new FakeAuthenticator()
    await addKey(user, device)

    const login = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'passkey_second', password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    expect(login.json().status).toBe('mfa_required')
    expect(login.json().methods).toEqual(['passkey'])
    const mfaCookie = cookieOf(login.headers['set-cookie'], 'kchs_mfa')
    expect(mfaCookie).toBeTruthy()

    const options = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/passkey/options',
      headers: { cookie: mfaCookie },
    })
    expect(options.statusCode).toBe(200)
    const credential = device.authenticate(options.json().challenge, origin, rpId, user.id)
    const verified = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/passkey/verify',
      headers: { cookie: mfaCookie },
      payload: { credential },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json().status).toBe('ok')
    const session = cookieOf(verified.headers['set-cookie'], 'kchs_session')
    const me = await call(fx.app, { url: '/me', headers: { cookie: session } })
    expect(me.json().user.login).toBe('passkey_second')
  })

  it('чужим ключом чужой вход не подтвердить', async () => {
    const victim = await createUser(fx.app, 'passkey_victim', ['employee'])
    const attacker = await createUser(fx.app, 'passkey_attacker', ['employee'])
    const victimDevice = new FakeAuthenticator()
    const attackerDevice = new FakeAuthenticator()
    await addKey(victim, victimDevice)
    await addKey(attacker, attackerDevice)

    const login = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'passkey_victim', password: PASSWORD },
    })
    const mfaCookie = cookieOf(login.headers['set-cookie'], 'kchs_mfa')
    const options = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/passkey/options',
      headers: { cookie: mfaCookie },
    })
    // Ответ подписывает ключ нападающего — сервер сверяет владельца вызова
    const credential = attackerDevice.authenticate(options.json().challenge, origin, rpId)
    const verified = await call(fx.app, {
      method: 'POST',
      url: '/auth/mfa/passkey/verify',
      headers: { cookie: mfaCookie },
      payload: { credential },
    })
    expect(verified.statusCode).toBe(401)
  })

  it('без вызова входа подтверждение ключом невозможно', async () => {
    const response = await call(fx.app, { method: 'POST', url: '/auth/mfa/passkey/options' })
    expect(response.statusCode).toBe(401)
  })

  it('ключ закрывает требование политики о втором факторе', async () => {
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/security-policy',
      as: fx.admin,
      payload: { requireMfaRoles: ['employee'] },
    })
    expect(patch.statusCode).toBe(200)
    try {
      const user = await createUser(fx.app, 'passkey_policy', ['employee'])
      const me = await call(fx.app, { url: '/me', as: user })
      expect(me.json().mfaEnrollmentRequired).toBe(true)
      // Обычные маршруты закрыты, а подключение ключа — открыто
      expect((await call(fx.app, { url: '/me/passkeys', as: user })).statusCode).toBe(200)
      expect((await call(fx.app, { url: '/inbox', as: user })).statusCode).toBe(403)

      await addKey(user, new FakeAuthenticator())
      const after = await call(fx.app, { url: '/me', as: user })
      expect(after.json().mfaEnrollmentRequired).toBe(false)
      expect((await call(fx.app, { url: '/inbox', as: user })).statusCode).toBe(200)
    } finally {
      await call(fx.app, {
        method: 'PATCH',
        url: '/admin/security-policy',
        as: fx.admin,
        payload: { requireMfaRoles: [] },
      })
      SecurityPolicyService.invalidate()
    }
  })
})
