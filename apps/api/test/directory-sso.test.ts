import type { DirectorySettingsInput, DirectorySyncRun, SsoSettingsInput } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeEntry, type FakeLdap, startFakeLdap } from './fake-ldap.js'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Каталог LDAP/AD и единый вход OIDC (P5-E04, ADR-0098). Внешние службы не
 * нужны: каталог и IdP поднимаются поддельными в самом тесте.
 */
registerLifecycle()

const { startFakeIdp } = await import('./fake-idp.js')
const { config } = await import('../src/shared/config/index.js')
const { users } = await import('../src/shared/db/schema/index.js')

const BASE_DN = 'ou=people,dc=example,dc=org'
const UNIT_DN = 'ou=units,dc=example,dc=org'
const READER_DN = 'cn=reader,dc=example,dc=org'
const READER_PASSWORD = 'reader-secret'
const IVANOV_DN = `uid=ivanov,${BASE_DN}`
const PETROV_DN = `uid=petrov,${BASE_DN}`
const IVANOV_PASSWORD = 'Directory!Pass-2026'

let fx: TestContext
let ldap: FakeLdap
let idp: Awaited<ReturnType<typeof startFakeIdp>>

function person(uid: string, overrides: Partial<Record<string, string[]>> = {}): FakeEntry {
  return {
    dn: `uid=${uid},${BASE_DN}`,
    attributes: {
      objectClass: ['top', 'person', 'inetOrgPerson'],
      uid: [uid],
      entryUUID: [`uuid-${uid}`],
      mail: [`${uid}@example.org`],
      givenName: ['Иван'],
      sn: ['Иванов'],
      displayName: [`Иванов ${uid}`],
      telephoneNumber: ['+992900000000'],
      department: ['Отдел ГИС'],
      title: ['Главный специалист'],
      memberOf: [`cn=gis,ou=groups,dc=example,dc=org`],
      ...overrides,
    },
  }
}

function unit(name: string): FakeEntry {
  return {
    dn: `ou=${name},${UNIT_DN}`,
    attributes: {
      objectClass: ['top', 'organizationalUnit'],
      ou: [name],
      description: [name],
    },
  }
}

const baseEntries = (): FakeEntry[] => [
  person('ivanov'),
  person('petrov', { memberOf: ['cn=other,ou=groups,dc=example,dc=org'] }),
  unit('Отдел ГИС'),
]

const passwords = (): Record<string, string> => ({
  [READER_DN]: READER_PASSWORD,
  [IVANOV_DN]: IVANOV_PASSWORD,
  [PETROV_DN]: 'Another!Pass-2026',
})

function directoryInput(overrides: Partial<DirectorySettingsInput> = {}): DirectorySettingsInput {
  return {
    enabled: true,
    url: ldap.url,
    startTls: false,
    tlsRejectUnauthorized: true,
    bindDn: READER_DN,
    bindPassword: READER_PASSWORD,
    baseDn: BASE_DN,
    userFilter: '(objectClass=person)',
    unitBaseDn: UNIT_DN,
    unitFilter: '(objectClass=organizationalUnit)',
    attributes: {
      login: 'uid',
      email: 'mail',
      firstName: 'givenName',
      lastName: 'sn',
      middleName: '',
      displayName: 'displayName',
      phone: 'telephoneNumber',
      externalId: 'entryUUID',
      disabled: 'nsAccountLock',
      unit: 'department',
      position: 'title',
      memberOf: 'memberOf',
    },
    groupMappings: [{ group: 'cn=gis,ou=groups,dc=example,dc=org', roleKey: 'gis_admin' }],
    defaultRoleKeys: ['employee'],
    onMissing: 'block',
    syncIntervalMinutes: 60,
    allowPasswordLogin: true,
    pageSize: 500,
    ...overrides,
  } as DirectorySettingsInput
}

async function saveDirectory(overrides: Partial<DirectorySettingsInput> = {}): Promise<void> {
  const response = await call(fx.app, {
    method: 'PUT',
    url: '/admin/directory',
    as: fx.admin,
    payload: directoryInput(overrides),
  })
  expect(response.statusCode).toBe(200)
}

async function sync(path: 'sync' | 'preview'): Promise<DirectorySyncRun> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/admin/directory/${path}`,
    as: fx.admin,
  })
  expect(response.statusCode).toBe(200)
  return response.json<DirectorySyncRun>()
}

beforeAll(async () => {
  fx = await setupFixture()
  ldap = await startFakeLdap({ entries: baseEntries(), passwords: passwords() })
  idp = await startFakeIdp()
})

afterAll(async () => {
  await ldap?.close()
  await idp?.close()
})

describe('каталог LDAP/AD: настройка', () => {
  it('пароль учётной записи чтения наружу не возвращается', async () => {
    await saveDirectory()
    const response = await call(fx.app, { url: '/admin/directory', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const state = response.json()
    expect(state.hasBindPassword).toBe(true)
    expect(state.bindDn).toBe(READER_DN)
    expect(JSON.stringify(state)).not.toContain(READER_PASSWORD)
  })

  it('сопоставление на несуществующую роль отклоняется', async () => {
    const response = await call(fx.app, {
      method: 'PUT',
      url: '/admin/directory',
      as: fx.admin,
      payload: directoryInput({
        groupMappings: [{ group: 'cn=x,dc=example,dc=org', roleKey: 'нет-такой-роли' }],
      }),
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('validation_failed')
  })

  it('настройка каталога — только администратору системы', async () => {
    const read = await call(fx.app, { url: '/admin/directory', as: fx.users.member })
    expect(read.statusCode).toBe(403)
    const write = await call(fx.app, {
      method: 'PUT',
      url: '/admin/directory',
      as: fx.users.member,
      payload: directoryInput(),
    })
    expect(write.statusCode).toBe(403)
    const run = await call(fx.app, {
      method: 'POST',
      url: '/admin/directory/sync',
      as: fx.users.member,
    })
    expect(run.statusCode).toBe(403)
  })

  it('«Проверить соединение» считает записи каталога', async () => {
    await saveDirectory()
    const response = await call(fx.app, {
      method: 'POST',
      url: '/admin/directory/test',
      as: fx.admin,
    })
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(result.ok).toBe(true)
    expect(result.users).toBe(2)
    expect(result.units).toBe(1)
    expect(result.sample).toContain('ivanov')
  })

  it('недоступный каталог — понятная ошибка, а не падение', async () => {
    await saveDirectory({ url: 'ldap://127.0.0.1:1' })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/admin/directory/test',
      as: fx.admin,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().ok).toBe(false)
    expect(response.json().error).toBeTruthy()
    await saveDirectory()
  })
})

describe('каталог LDAP/AD: синхронизация', () => {
  it('предпросмотр показывает план и ничего не записывает', async () => {
    ldap.set({ entries: baseEntries(), passwords: passwords() })
    await saveDirectory()

    const preview = await sync('preview')
    expect(preview.mode).toBe('preview')
    expect(preview.status).toBe('succeeded')
    expect(preview.stats.created).toBe(2)
    expect(preview.stats.unitsCreated).toBe(1)
    expect(
      preview.changes.some((item) => item.login === 'ivanov' && item.action === 'create'),
    ).toBe(true)

    const before = await call(fx.app, { url: '/users?q=ivanov', as: fx.admin })
    expect(before.json().items).toHaveLength(0)
  })

  it('прогон заводит сотрудников, подразделение и роли по группам', async () => {
    const run = await sync('sync')
    expect(run.status).toBe('succeeded')
    expect(run.stats.created).toBe(2)
    expect(run.stats.unitsCreated).toBe(1)

    const list = await call(fx.app, { url: '/users?q=ivanov', as: fx.admin })
    const created = list.json().items[0]
    expect(created.login).toBe('ivanov')
    expect(created.email).toBe('ivanov@example.org')
    expect(created.roles).toContain('gis_admin')

    const tree = await call(fx.app, { url: '/org/units', as: fx.admin })
    expect(tree.json().items.some((item: { code: string }) => item.code === 'ОТДЕЛ-ГИС')).toBe(true)
  })

  it('повторный прогон ничего не меняет', async () => {
    const run = await sync('sync')
    expect(run.stats.created).toBe(0)
    expect(run.stats.updated).toBe(0)
    expect(run.stats.blocked).toBe(0)
    expect(run.stats.failed).toBe(0)
  })

  it('журнал синхронизаций доступен администратору', async () => {
    const response = await call(fx.app, { url: '/admin/directory/syncs?limit=10', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const items = response.json().items as DirectorySyncRun[]
    expect(items.length).toBeGreaterThanOrEqual(3)
    expect((items[0]?.startedAt ?? '') >= (items[1]?.startedAt ?? '')).toBe(true)
    expect(items.some((item) => item.mode === 'preview')).toBe(true)
  })

  it('локальная учётная запись с тем же логином каталогу не отдаётся', async () => {
    const local = await createUser(fx.app, 'localtwin', ['employee'])
    expect(local.id).toBeTruthy()
    ldap.set({
      entries: [...baseEntries(), person('localtwin')],
      passwords: { ...passwords(), [`uid=localtwin,${BASE_DN}`]: 'Whatever-2026' },
    })
    const run = await sync('sync')
    expect(run.changes.some((item) => item.login === 'localtwin' && item.action === 'skip')).toBe(
      true,
    )
    const [row] = await db()
      .select({ authSource: users.authSource })
      .from(users)
      .where(eq(users.login, 'localtwin'))
    expect(row?.authSource).toBe('local')
  })

  it('отключённый в каталоге сотрудник блокируется', async () => {
    ldap.set({
      entries: [person('ivanov', { nsAccountLock: ['TRUE'] }), person('petrov'), unit('Отдел ГИС')],
      passwords: passwords(),
    })
    const run = await sync('sync')
    expect(run.stats.blocked).toBeGreaterThanOrEqual(1)
    const list = await call(fx.app, { url: '/users?q=ivanov', as: fx.admin })
    expect(list.json().items[0]?.status).toBe('blocked')
  })

  it('исчезнувший из каталога сотрудник блокируется', async () => {
    ldap.set({ entries: [person('ivanov'), unit('Отдел ГИС')], passwords: passwords() })
    const run = await sync('sync')
    expect(
      run.changes.some((item) => item.login === 'petrov' && item.reason === 'нет в каталоге'),
    ).toBe(true)
    const list = await call(fx.app, { url: '/users?q=petrov', as: fx.admin })
    expect(list.json().items[0]?.status).toBe('blocked')
  })
})

describe('каталог LDAP/AD: вход по паролю каталога', () => {
  beforeAll(async () => {
    ldap.set({ entries: baseEntries(), passwords: passwords() })
    await saveDirectory()
    await sync('sync')
  })

  it('пароль проверяется привязкой в каталоге', async () => {
    const before = ldap.binds.length
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'ivanov', password: IVANOV_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('ok')
    // Привязка учётной записи чтения для поиска и привязка самого сотрудника
    expect(ldap.binds.slice(before).some((item) => item.dn === IVANOV_DN && item.ok)).toBe(true)
  })

  it('неверный пароль каталога не пускает', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'ivanov', password: 'не-тот-пароль' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('локальный пароль учётной записи каталога не подходит', async () => {
    // У записи каталога локальный пароль случайный и никому не известен
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'ivanov', password: 'Test!Password-2026-x' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('отключённый в каталоге сотрудник не входит, даже зная пароль', async () => {
    ldap.set({
      entries: [person('ivanov', { nsAccountLock: ['TRUE'] }), person('petrov'), unit('Отдел ГИС')],
      passwords: passwords(),
    })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'ivanov', password: IVANOV_PASSWORD },
    })
    expect(response.statusCode).toBe(401)
    ldap.set({ entries: baseEntries(), passwords: passwords() })
  })

  it('выключенный вход по паролю каталога закрывает вход', async () => {
    await saveDirectory({ allowPasswordLogin: false })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'ivanov', password: IVANOV_PASSWORD },
    })
    expect(response.statusCode).toBe(401)
    await saveDirectory()
  })

  it('серия неудач блокирует учётную запись каталога так же, как локальную', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await call(fx.app, {
        method: 'POST',
        url: '/auth/login',
        payload: { login: 'petrov', password: 'не-тот-пароль' },
      })
    }
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'petrov', password: 'Another!Pass-2026' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().detail).toContain('заблокирована')
  })
})

describe('единый вход OIDC', () => {
  function ssoInput(overrides: Partial<SsoSettingsInput> = {}): SsoSettingsInput {
    return {
      enabled: true,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      scopes: 'openid profile email',
      buttonLabel: 'Корпоративная учётная запись',
      claims: {
        login: 'preferred_username',
        email: 'email',
        firstName: 'given_name',
        lastName: 'family_name',
        middleName: '',
        displayName: 'name',
        groups: 'groups',
      },
      groupMappings: [{ group: 'kchs-gis', roleKey: 'gis_admin' }],
      defaultRoleKeys: ['employee'],
      jitCreate: true,
      endSessionOnLogout: true,
      allowInsecureHttp: true,
      ...overrides,
    } as SsoSettingsInput
  }

  async function saveSso(overrides: Partial<SsoSettingsInput> = {}): Promise<void> {
    const response = await call(fx.app, {
      method: 'PUT',
      url: '/admin/sso',
      as: fx.admin,
      payload: ssoInput(overrides),
    })
    expect(response.statusCode).toBe(200)
  }

  /** Начало входа: возвращает параметры, которые платформа отправила IdP. */
  async function start(): Promise<{ state: string; nonce: string; codeChallenge: string }> {
    const response = await call(fx.app, { method: 'POST', url: '/auth/sso/start' })
    expect(response.statusCode).toBe(200)
    const url = new URL(response.json().url)
    return {
      state: url.searchParams.get('state') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      codeChallenge: url.searchParams.get('code_challenge') ?? '',
    }
  }

  const redirectUri = () => `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1/auth/sso/callback`

  async function callback(code: string, state: string) {
    return call(fx.app, {
      url: `/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    })
  }

  beforeAll(async () => {
    await saveSso()
  })

  it('секрет клиента наружу не возвращается', async () => {
    const response = await call(fx.app, { url: '/admin/sso', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const state = response.json()
    expect(state.hasClientSecret).toBe(true)
    expect(state.redirectUri).toBe(redirectUri())
    expect(JSON.stringify(state)).not.toContain(idp.clientSecret)
  })

  it('«Проверить соединение» читает конфигурацию издателя', async () => {
    const response = await call(fx.app, { method: 'POST', url: '/admin/sso/test', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const result = response.json()
    expect(result.ok).toBe(true)
    expect(result.issuer).toBe(idp.issuer)
    expect(result.endSessionEndpoint).toBe(`${idp.issuer}/logout`)
  })

  it('экран входа знает о включённом едином входе', async () => {
    const response = await call(fx.app, { url: '/auth/methods' })
    expect(response.statusCode).toBe(200)
    expect(response.json().sso).toEqual({
      enabled: true,
      buttonLabel: 'Корпоративная учётная запись',
    })
  })

  it('вход создаёт сотрудника и сессию, роли берутся из групп IdP', async () => {
    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: {
        sub: 'sso-user-1',
        preferred_username: 'sidorov',
        email: 'sidorov@example.org',
        given_name: 'Пётр',
        family_name: 'Сидоров',
        name: 'Сидоров Пётр',
        groups: ['kchs-gis'],
      },
    })
    const response = await callback(code, state)
    expect(response.statusCode).toBe(302)
    const cookie = sessionCookie(response.headers['set-cookie'])
    expect(cookie).toBeTruthy()

    const me = await call(fx.app, {
      url: '/me',
      headers: { cookie },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.login).toBe('sidorov')
    expect(me.json().roles).toContain('gis_admin')
  })

  it('повторный вход тем же субъектом не заводит второго сотрудника', async () => {
    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-1', preferred_username: 'sidorov', email: 'sidorov@example.org' },
    })
    expect((await callback(code, state)).statusCode).toBe(302)
    const list = await call(fx.app, { url: '/users?q=sidorov', as: fx.admin })
    expect(list.json().items).toHaveLength(1)
  })

  it('чужая строка состояния не пускает', async () => {
    const { nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-2', preferred_username: 'stranger' },
    })
    const response = await callback(code, 'чужое-состояние')
    expect(response.statusCode).toBe(401)
  })

  it('повторный ответ с той же строкой состояния не проходит', async () => {
    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-3', preferred_username: 'repeater' },
    })
    expect((await callback(code, state)).statusCode).toBe(302)
    const again = await callback(code, state)
    expect(again.statusCode).toBe(401)
  })

  it('чужой nonce в токене не принимается', async () => {
    const { state, codeChallenge } = await start()
    const code = idp.authorize({
      nonce: 'подменённый-nonce',
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-4', preferred_username: 'nonceless' },
    })
    const response = await callback(code, state)
    expect(response.statusCode).toBe(401)
    const list = await call(fx.app, { url: '/users?q=nonceless', as: fx.admin })
    expect(list.json().items).toHaveLength(0)
  })

  it('просроченный код обменять нельзя', async () => {
    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-5', preferred_username: 'expired' },
      expired: true,
    })
    const response = await callback(code, state)
    expect(response.statusCode).toBe(401)
  })

  it('отключённая учётная запись через IdP не входит', async () => {
    const blocked = await createUser(fx.app, 'ssoblocked', ['employee'])
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${blocked.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(patch.statusCode).toBe(200)

    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-6', preferred_username: 'ssoblocked' },
    })
    const response = await callback(code, state)
    expect(response.statusCode).toBe(401)
  })

  it('без JIT-создания незнакомый сотрудник не входит', async () => {
    await saveSso({ jitCreate: false })
    const { state, nonce, codeChallenge } = await start()
    const code = idp.authorize({
      nonce,
      codeChallenge,
      redirectUri: redirectUri(),
      claims: { sub: 'sso-user-7', preferred_username: 'unknownperson' },
    })
    const response = await callback(code, state)
    expect(response.statusCode).toBe(401)
    await saveSso()
  })

  it('выключенный единый вход не начинается', async () => {
    await saveSso({ enabled: false })
    const response = await call(fx.app, { method: 'POST', url: '/auth/sso/start' })
    expect(response.statusCode).toBe(400)
    const methods = await call(fx.app, { url: '/auth/methods' })
    expect(methods.json().sso.enabled).toBe(false)
    await saveSso()
  })

  it('выход подсказывает адрес завершения сессии IdP', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/logout',
      as: await createUser(fx.app, 'logoutuser', ['employee']),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().endSessionUrl).toContain(`${idp.issuer}/logout`)
  })
})

function sessionCookie(raw: unknown): string {
  const text = Array.isArray(raw) ? raw.join(';') : String(raw)
  return (
    text
      .split(';')
      .find((part) => part.includes('kchs_session='))
      ?.trim() ?? ''
  )
}
