import { and, eq, sql } from 'drizzle-orm'
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
 * Служебные учётные записи (ADR-0130, решение владельца по N37 и N47): от их
 * имени работают правила; войти ими нельзя никаким способом, уведомлений и дел
 * они не получают, назначения и пикеры людей их не выбирают, а консоль и выдача
 * доступа показывают их с отметкой.
 */
registerLifecycle()

const { AuthService } = await import('../src/modules/identity/public.js')
const { DirectoryQueries, DelegationService, GroupService, OrgService } = await import(
  '../src/modules/identity/public.js'
)
const { NotificationService } = await import('../src/kernel/notifications/service.js')
const { InboxService } = await import('../src/kernel/inbox/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { buildUserCtxFor } = await import('../src/kernel/access/explain.js')
const { auditLog, inboxItems, notifications, passwordResets, sessions, users } = await import(
  '../src/shared/db/schema/index.js'
)
const { hashToken } = await import('../src/shared/crypto/secrets.js')
const { newId, randomToken } = await import('../src/shared/ids.js')

const meta = { ip: '127.0.0.1', userAgent: 'vitest', requestId: 'svc-test' }
const run = Date.now().toString(36)

let fx: TestContext
let orgAdmin: TestUser
let bot: { id: string; login: string }

interface Account {
  id: string
  login: string
  name: string
  status: string
  roles: string[]
  unit: { id: string; name: string } | null
  spaces: Array<{ spaceId: string; role: string }>
}

async function createAccount(
  payload: Record<string, unknown>,
  as: TestUser = fx.admin,
): Promise<{ statusCode: number; body: string; account: Account }> {
  const response = await call(fx.app, { method: 'POST', url: '/service-accounts', as, payload })
  return {
    statusCode: response.statusCode,
    body: response.body,
    account: response.statusCode === 200 ? (response.json() as Account) : (null as never),
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  // Администратор оргструктуры: `users.manage` без прав администратора системы
  orgAdmin = await createUser(fx.app, `org_admin_${run}`, ['org_admin'])
  const created = await createAccount({
    name: `Автоматизация канцелярии ${run}`,
    description: 'Правила регистрации входящих',
    roleKeys: ['employee', 'registrar'],
    unitId: fx.unitId,
    spaces: [{ spaceId: fx.spaceId, role: 'editor' }],
  })
  expect(created.statusCode, created.body).toBe(200)
  bot = created.account
})

describe('служебная учётная запись: ведение', () => {
  it('заводится администратором с ролями, подразделением и пространством', async () => {
    const response = await call(fx.app, { url: `/service-accounts/${bot.id}`, as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const account = response.json() as Account
    expect(account.login.startsWith('svc-')).toBe(true)
    expect(account.roles.sort()).toEqual(['employee', 'registrar'])
    expect(account.unit?.id).toBe(fx.unitId)
    expect(account.spaces).toEqual([
      { spaceId: fx.spaceId, title: 'Тестовое пространство', role: 'editor' },
    ])

    const [row] = await db()
      .select({ kind: users.kind, description: users.description })
      .from(users)
      .where(eq(users.id, bot.id))
    expect(row).toEqual({ kind: 'service', description: 'Правила регистрации входящих' })
  })

  it('администратором системы не бывает ни при создании, ни при правке', async () => {
    const created = await createAccount({ name: 'Всемогущий робот', roleKeys: ['system_admin'] })
    expect(created.statusCode).toBe(400)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${bot.id}`,
      as: fx.admin,
      payload: { roleKeys: ['system_admin'] },
    })
    expect(patched.statusCode).toBe(400)
  })

  it('имя и почта служебной записи не правятся через раздел сотрудников', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${bot.id}`,
      as: fx.admin,
      payload: { email: 'robot@example.org' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('правка заменяет набор пространств и меняет назначение', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/service-accounts/${bot.id}`,
      as: fx.admin,
      payload: {
        description: 'Правила регистрации и рассылки',
        spaces: [{ spaceId: fx.orgSpaceId, role: 'member' }],
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const account = response.json() as Account & { description: string }
    expect(account.description).toBe('Правила регистрации и рассылки')
    expect(account.spaces.map((item) => [item.spaceId, item.role])).toEqual([
      [fx.orgSpaceId, 'member'],
    ])

    // Возвращаем пространство теста: дальше служебная запись им пользуется
    const back = await call(fx.app, {
      method: 'PATCH',
      url: `/service-accounts/${bot.id}`,
      as: fx.admin,
      payload: { spaces: [{ spaceId: fx.spaceId, role: 'editor' }] },
    })
    expect(back.statusCode, back.body).toBe(200)
  })

  it('список видят администраторы людей; сотруднику он закрыт', async () => {
    const forAdmin = await call(fx.app, { url: '/service-accounts', as: orgAdmin })
    expect(forAdmin.statusCode, forAdmin.body).toBe(200)
    expect(forAdmin.json().items.some((item: Account) => item.id === bot.id)).toBe(true)

    const forEmployee = await call(fx.app, { url: '/service-accounts', as: fx.users.member })
    expect(forEmployee.statusCode).toBe(403)
    const create = await createAccount({ name: 'Нельзя' }, fx.users.member)
    expect(create.statusCode).toBe(403)
  })

  it('администратор оргструктуры заводит запись только на базовой роли', async () => {
    const allowed = await createAccount({ name: `Робот оргструктуры ${run}` }, orgAdmin)
    expect(allowed.statusCode, allowed.body).toBe(200)
    const denied = await createAccount(
      { name: 'Робот-аудитор', roleKeys: ['security_auditor'] },
      orgAdmin,
    )
    expect(denied.statusCode).toBe(403)
  })

  it('в пространство включает только тот, кто вправе в него приглашать', async () => {
    // Администратор оргструктуры не участник тестового пространства
    const denied = await createAccount(
      { name: 'Робот чужого пространства', spaces: [{ spaceId: fx.spaceId, role: 'editor' }] },
      orgAdmin,
    )
    expect([403, 404]).toContain(denied.statusCode)

    // Администратором пространства служебная запись не бывает и через раздел участников
    const asAdmin = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${fx.spaceId}/members`,
      as: fx.admin,
      payload: { userId: bot.id, role: 'admin' },
    })
    expect(asAdmin.statusCode).toBe(400)
  })

  it('консоль отличает служебные записи от сотрудников', async () => {
    const service = await call(fx.app, { url: '/users?kind=service&limit=200', as: fx.admin })
    expect(service.statusCode, service.body).toBe(200)
    const items = service.json().items as Array<{ id: string; kind: string }>
    expect(items.every((item) => item.kind === 'service')).toBe(true)
    expect(items.some((item) => item.id === bot.id)).toBe(true)

    const people = await call(fx.app, { url: '/users?kind=person&limit=200', as: fx.admin })
    expect(people.json().items.some((item: { id: string }) => item.id === bot.id)).toBe(false)
  })
})

describe('служебная учётная запись: вход', () => {
  it('по паролю — как неизвестный логин, с причиной в аудите', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      payload: { login: bot.login, password: 'Любой-Пароль-2026!' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.body).toContain('Неверный логин или пароль')

    const [entry] = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'user.login_failed'), eq(auditLog.actorId, bot.id)))
      .limit(1)
    expect((entry?.details as { reason?: string } | undefined)?.reason).toBe('service_account')
  })

  it('сессию не выдаёт ни один способ входа', async () => {
    // Общий рубеж пароля, LDAP, OIDC и ключа входа
    await expect(AuthService.createSession(bot.id, meta, false)).rejects.toThrow(
      'Неверный логин или пароль',
    )
  })

  it('пароль не задаётся и не восстанавливается', async () => {
    await expect(AuthService.setPassword(bot.id, 'Очень-Надёжный-Пароль-2026')).rejects.toThrow(
      'нет пароля',
    )
    const reset = await call(fx.app, {
      method: 'POST',
      url: `/users/${bot.id}/reset-password`,
      as: fx.admin,
    })
    expect(reset.statusCode).toBe(400)

    expect(await AuthService.requestPasswordReset(bot.login)).toBeNull()
    const [pending] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(passwordResets)
      .where(eq(passwordResets.userId, bot.id))
    expect(pending?.count).toBe(0)
  })

  it('чужая сессия служебной записи не пропускается', async () => {
    // Сессия, которой не могло быть: её не принимает контекст запроса
    const token = randomToken(32)
    await db()
      .insert(sessions)
      .values({
        id: newId(),
        userId: bot.id,
        tokenHash: hashToken(token),
        csrfToken: randomToken(24),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    const response = await call(fx.app, {
      url: '/me',
      headers: { cookie: `kchs_session=${token}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it('работает по токену API, который выпустил администратор, и перестаёт после блокировки', async () => {
    const issued = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.admin,
      payload: { name: `Интеграция ${run}`, scopes: ['read:objects'], userId: bot.id },
    })
    expect(issued.statusCode, issued.body).toBe(200)
    const secret = issued.json().secret as string

    const read = await call(fx.app, {
      method: 'POST',
      url: '/objects/batch-get',
      headers: { authorization: `Bearer ${secret}` },
      payload: { ids: [fx.spaceId] },
    })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().items).toHaveLength(1)

    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/service-accounts/${bot.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/objects/batch-get',
      headers: { authorization: `Bearer ${secret}` },
      payload: { ids: [fx.spaceId] },
    })
    expect(denied.statusCode).toBe(401)

    const back = await call(fx.app, {
      method: 'PATCH',
      url: `/service-accounts/${bot.id}`,
      as: fx.admin,
      payload: { status: 'active' },
    })
    expect(back.statusCode, back.body).toBe(200)
  })
})

describe('служебная учётная запись: уведомления и дела', () => {
  it('уведомление уходит только людям', async () => {
    await NotificationService.notify({
      userIds: [bot.id, fx.users.member.id],
      category: 'system',
      titleKey: 'notifications.tpl.automation',
      params: { text: `Проверка ${run}` },
      objectId: fx.spaceId,
    })
    const rows = await db()
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(sql`${notifications.params}->>'text' = ${`Проверка ${run}`}`)
    expect(rows.map((row) => row.userId)).toEqual([fx.users.member.id])
  })

  it('дело Входящих служебной записи не открывается', async () => {
    await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: bot.id,
        kind: 'alert',
        objectId: fx.spaceId,
        titleKey: 'inbox.titles.task',
        dedupeKey: `svc-inbox-${run}`,
      }),
    )
    const rows = await db()
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(eq(inboxItems.userId, bot.id))
    expect(rows).toHaveLength(0)
  })
})

describe('служебная учётная запись: назначения и пикеры', () => {
  it('не выбирается ролью, подразделением, группой и списком людей', async () => {
    const registrars = await DirectoryQueries.usersWithRole('registrar', {
      spaceId: null,
      scope: 'effective',
    })
    expect(registrars).not.toContain(bot.id)

    const members = await DirectoryQueries.unitMembers(fx.unitId)
    expect(members).toContain(fx.users.member.id)
    expect(members).not.toContain(bot.id)

    const groupId = await db().transaction((tx) => GroupService.create(tx, `Группа ${run}`))
    await db().transaction((tx) =>
      GroupService.setMembers(tx, groupId, [bot.id, fx.users.member.id]),
    )
    expect(await DirectoryQueries.groupMembers(groupId)).toEqual([fx.users.member.id])

    expect(await DirectoryQueries.activeUsers([bot.id, fx.users.member.id])).toEqual([
      fx.users.member.id,
    ])
    expect(await OrgService.members([fx.unitId])).not.toContain(bot.id)
  })

  it('пикеры людей её не показывают, выдача доступа — показывает с отметкой', async () => {
    const q = encodeURIComponent(`Автоматизация канцелярии ${run}`)
    const people = await call(fx.app, {
      url: `/principals/search?q=${q}&types=user`,
      as: fx.admin,
    })
    expect(people.statusCode, people.body).toBe(200)
    expect(people.json().items).toHaveLength(0)

    const access = await call(fx.app, {
      url: `/principals/search?q=${q}&types=user&serviceAccounts=include`,
      as: fx.admin,
    })
    expect(access.json().items).toEqual([
      expect.objectContaining({ type: 'user', id: bot.id, service: true }),
    ])
  })

  it('не становится руководителем подразделения и заместителем', async () => {
    const head = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${fx.unitId}`,
      as: fx.admin,
      payload: { headUserId: bot.id },
    })
    expect(head.statusCode).toBe(400)

    const memberCtx = await buildUserCtxFor(fx.users.member.id)
    await expect(
      db().transaction((tx) =>
        DelegationService.create(tx, memberCtx!, {
          toUserId: bot.id,
          scope: 'all',
          startsAt: new Date().toISOString(),
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      ),
    ).rejects.toThrow('служебную запись')
  })
})

describe('служебная учётная запись: правила', () => {
  it('правило работает от служебной записи и не работает от сотрудника', async () => {
    const definition = (runAs: string) => ({
      spaceId: fx.spaceId,
      definition: {
        name: { ru: `Правило ${run}` },
        runAs,
        enabled: false,
        trigger: { kind: 'event', type: 'object.created', filter: {} },
        actions: [{ type: 'add_tag', tag: 'робот' }],
      },
    })
    const byBot = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules',
      as: fx.admin,
      payload: definition(bot.id),
    })
    expect(byBot.statusCode, byBot.body).toBe(200)

    const byPerson = await call(fx.app, {
      method: 'POST',
      url: '/automation/rules',
      as: fx.admin,
      payload: definition(fx.users.member.id),
    })
    expect(byPerson.statusCode).toBe(400)
    expect(byPerson.body).toContain('служебной учётной записи')
  })
})
