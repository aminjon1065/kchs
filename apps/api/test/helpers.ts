import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll } from 'vitest'

/**
 * Интеграционные тесты работают с отдельной базой kchs_test. Слот
 * `KCHS_TEST_SLOT=N` даёт параллельному прогону свою базу `kchs_test_N`, базу
 * Redis и префикс индекса (база создаётся `scripts/test-slot.sh N`).
 */
process.env.KCHS_ENV_FILE =
  process.env.KCHS_ENV_FILE ?? new URL('../../../.env', import.meta.url).pathname
await import('../src/shared/config/load-env.js')

const slot = Number(process.env.KCHS_TEST_SLOT ?? 0)
if (!Number.isInteger(slot) || slot < 0 || slot > 14) {
  throw new Error('KCHS_TEST_SLOT: целое число 0…14')
}
const testDb = slot ? `kchs_test_${slot}` : 'kchs_test'

const base = process.env.DATABASE_URL ?? ''
process.env.DATABASE_URL = base.replace(/\/kchs(\?|$)/, `/${testDb}$1`)
process.env.DATABASE_MIGRATOR_URL = (process.env.DATABASE_MIGRATOR_URL ?? '').replace(
  /\/kchs(\?|$)/,
  `/${testDb}$1`,
)
// Пользовательские запросы к датасетам (роль kchs_query) — в той же тестовой базе
if (process.env.DATABASE_QUERY_URL) {
  process.env.DATABASE_QUERY_URL = process.env.DATABASE_QUERY_URL.replace(
    /\/kchs(\?|$)/,
    `/${testDb}$1`,
  )
}
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.ROLE = 'api'

// Redis и поисковый индекс тоже отдельные: тесты не трогают кэши, очереди и
// индекс работающего стенда разработки
process.env.REDIS_URL = withRedisDb(process.env.REDIS_URL ?? '', 1 + slot)
process.env.MEILI_INDEX_PREFIX = slot ? `test${slot}_` : 'test_'
// Базовые карты стенда (PMTiles, шрифты) лежат в общем бакете тайлов — тестам свой каталог
process.env.BASEMAPS_PREFIX = slot ? `test${slot}/basemaps` : 'test/basemaps'
// Вебхуки тестов ходят на localhost: защита от адресов внутренней сети (ADR-0097)
// проверяется отдельно, на выключенном флаге
process.env.WEBHOOKS_ALLOW_PRIVATE_ADDRESSES = 'true'

function withRedisDb(url: string, dbIndex: number): string {
  const parsed = new URL(url)
  parsed.pathname = `/${dbIndex}`
  return parsed.toString()
}

const { resetConfigCache } = await import('../src/shared/config/env.js')
resetConfigCache()

const { runMigrations } = await import('../src/shared/db/migrate.js')
const { bootstrapPlatform } = await import('../src/bootstrap.js')
const { buildApp } = await import('../src/app.js')
const { db, closeDb } = await import('../src/shared/db/client.js')
const { closeRedis, redis } = await import('../src/shared/redis/index.js')
const { resetData } = await import('../src/seed/seed.js')
const { UserService, OrgService } = await import('../src/modules/identity/public.js')
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { SecurityPolicyService } = await import('../src/kernel/settings/security-policy.js')
const { AuthProviders } = await import('../src/modules/identity/domain/auth-providers.js')
const { systemCtx } = await import('../src/shared/context.js')

export interface TestUser {
  id: string
  login: string
  password: string
  cookie: string
  csrf: string
}

export interface TestContext {
  app: FastifyInstance
  admin: TestUser
  users: { member: TestUser; stranger: TestUser; viewer: TestUser }
  spaceId: string
  orgSpaceId: string
  unitId: string
}

/** Ответ inject в форме, удобной для проверок. */
export interface TestResponse {
  statusCode: number
  body: string
  headers: Record<string, unknown>
  // biome-ignore lint/suspicious/noExplicitAny: в тестах удобнее работать без приведения типов
  json: <T = any>() => T
}

const PASSWORD = 'Test!Password-2026-x'

let app: FastifyInstance | null = null

export async function bootTestApp(): Promise<FastifyInstance> {
  if (app) return app
  await runMigrations()
  await bootstrapPlatform()
  app = await buildApp()
  return app
}

export async function resetTestData(): Promise<void> {
  await resetData()
  // Политика безопасности и поставщики входа кэшируются в процессе —
  // настройки только что удалены
  SecurityPolicyService.invalidate()
  AuthProviders.invalidate()
  await bootstrapPlatform()
  // Отдельная база Redis принадлежит только тестам: кэши, потоки событий, очереди
  await redis().flushdb()
}

export async function createUser(
  instance: FastifyInstance,
  login: string,
  roleKeys: string[] = ['employee'],
  unitId?: string,
): Promise<TestUser> {
  const ctx = systemCtx('test')
  const { id } = await db().transaction((tx) =>
    UserService.create(tx, ctx, {
      login,
      email: `${login}@test.local`,
      lastName: 'Тестов',
      firstName: login,
      roleKeys,
      password: PASSWORD,
      mustChangePassword: false,
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
      unitId: unitId ?? null,
    }),
  )
  return signIn(instance, login, id)
}

export async function signIn(
  instance: FastifyInstance,
  login: string,
  id: string,
): Promise<TestUser> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { login, password: PASSWORD },
  })
  if (response.statusCode !== 200) {
    throw new Error(`вход ${login} не выполнен: ${response.statusCode} ${response.body}`)
  }
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie)
  const cookie =
    raw
      .split(';')
      .find((p) => p.includes('kchs_session='))
      ?.trim() ?? ''
  const csrf = (response.json() as { csrfToken: string }).csrfToken
  return { id, login, password: PASSWORD, cookie, csrf }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  as?: TestUser
  payload?: unknown
  headers?: Record<string, string>
}

export async function call(
  instance: FastifyInstance,
  options: RequestOptions,
): Promise<TestResponse> {
  return instance.inject({
    method: options.method ?? 'GET',
    url: options.url.startsWith('/api') ? options.url : `/api/v1${options.url}`,
    ...(options.payload !== undefined ? { payload: options.payload } : {}),
    headers: {
      ...(options.as ? { cookie: options.as.cookie, 'x-csrf-token': options.as.csrf } : {}),
      ...options.headers,
    },
  } as InjectOptions) as unknown as Promise<TestResponse>
}

export async function setupFixture(): Promise<TestContext> {
  const instance = await bootTestApp()
  await resetTestData()

  const ctx = systemCtx('test')
  const admin = await createUser(instance, 'admin_test', ['system_admin'])

  const unitId = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: 'TEST',
      name: { ru: 'Тестовое подразделение' },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )

  const spaceId = await db().transaction((tx) =>
    SpaceService.create(tx, ctx, {
      key: 'test-space',
      name: 'Тестовое пространство',
      kind: 'team',
      ownerId: admin.id,
    }),
  )
  const orgSpaceId = await db().transaction((tx) =>
    SpaceService.create(tx, ctx, {
      key: 'test-org',
      name: 'Общее',
      kind: 'org',
      ownerId: admin.id,
    }),
  )

  const owner = admin
  const member = await createUser(instance, 'member_test', ['employee'], unitId)
  const stranger = await createUser(instance, 'stranger_test', ['employee'])
  const viewer = await createUser(instance, 'viewer_test', ['employee'])

  await db().transaction(async (tx) => {
    await SpaceService.addMember(tx, ctx, spaceId, member.id, 'editor')
    await SpaceService.addMember(tx, ctx, spaceId, viewer.id, 'viewer')
  })

  // Принципалы пересчитываются: членство изменилось
  await redis().del(`kchs:principals:${member.id}`, `kchs:principals:${viewer.id}`)

  return {
    app: instance,
    admin: owner,
    users: { member, stranger, viewer },
    spaceId,
    orgSpaceId,
    unitId,
  }
}

/**
 * Загрузка файла настоящим путём клиента: сессия → PUT по подписанной ссылке
 * в MinIO → подтверждение (09-files.md §2).
 */
/**
 * Служебная учётная запись (ADR-0130): от её имени работают правила и формы. Роль в
 * пространствах — редактор: форме и правилу нужна правка объектов пространства.
 */
export async function createServiceAccount(
  instance: FastifyInstance,
  as: TestUser,
  name: string,
  spaceIds: string[] = [],
): Promise<string> {
  const response = await call(instance, {
    method: 'POST',
    url: '/service-accounts',
    as,
    payload: { name, spaces: spaceIds.map((spaceId) => ({ spaceId, role: 'editor' })) },
  })
  if (response.statusCode !== 200) {
    throw new Error(`служебная запись не создана: ${response.statusCode} ${response.body}`)
  }
  return (response.json() as { id: string }).id
}

export async function uploadFile(
  instance: FastifyInstance,
  as: TestUser,
  input: {
    spaceId: string
    folderId?: string | null
    name: string
    content: string | Uint8Array
    mime?: string
    attachToObjectId?: string
  },
): Promise<{ id: string; name: string }> {
  const body = typeof input.content === 'string' ? Buffer.from(input.content) : input.content
  const mime = input.mime ?? 'text/plain'
  const session = await call(instance, {
    method: 'POST',
    url: '/files/upload-sessions',
    as,
    payload: {
      name: input.name,
      size: body.byteLength,
      mime,
      spaceId: input.spaceId,
      folderId: input.folderId ?? null,
      attachToObjectId: input.attachToObjectId ?? null,
    },
  })
  if (session.statusCode !== 200) {
    throw new Error(`сессия загрузки: ${session.statusCode} ${session.body}`)
  }
  const { uploadId, storageKey, singlePutUrl } = session.json()
  const put = await fetch(singlePutUrl, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': mime },
  })
  if (!put.ok) throw new Error(`загрузка в хранилище: ${put.status} ${await put.text()}`)
  const complete = await call(instance, {
    method: 'POST',
    url: `/files/upload-sessions/${uploadId}/complete`,
    as,
    payload: { uploadId, storageKey, parts: [] },
  })
  if (complete.statusCode !== 200) {
    throw new Error(`завершение загрузки: ${complete.statusCode} ${complete.body}`)
  }
  return { id: complete.json().id, name: input.name }
}

export function registerLifecycle(): void {
  beforeAll(async () => {
    await bootTestApp()
  })
  afterAll(async () => {
    await app?.close()
    await closeRedis()
    await closeDb()
  })
}

export { db, redis }
