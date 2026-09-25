import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Свои роли организации (ADR-0165): администратор заводит роль из способностей, права
 * держателей меняются сразу; держатель roles.manage не выдаёт больше, чем имеет сам;
 * системные роли и администрирование системы своими ролями не меняются.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

const capabilities = async (as: TestUser): Promise<string[]> =>
  (await call(fx.app, { url: '/me', as })).json().capabilities as string[]

async function createRole(as: TestUser, name: string, caps: string[]) {
  return call(fx.app, {
    method: 'POST',
    url: '/roles',
    as,
    payload: { name: { ru: name }, capabilities: caps },
  })
}

async function assign(userId: string, roleKeys: string[]) {
  const response = await call(fx.app, {
    method: 'PATCH',
    url: `/users/${userId}`,
    as: fx.admin,
    payload: { roleKeys },
  })
  expect(response.statusCode, response.body).toBe(200)
}

describe('свои роли', () => {
  it('роль из способностей назначается, правка способностей меняет права держателя сразу', async () => {
    const created = await createRole(fx.admin, `Выгрузка данных ${run}`, ['data.export'])
    expect(created.statusCode, created.body).toBe(200)
    const { id, key } = created.json() as { id: string; key: string }
    expect(key).toMatch(/^role_/)

    const holder = await createUser(fx.app, `role_holder_${run}`)
    expect(await capabilities(holder)).not.toContain('data.export')
    await assign(holder.id, ['employee', key])
    expect(await capabilities(holder)).toContain('data.export')

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/roles/${id}`,
      as: fx.admin,
      payload: { capabilities: ['data.export', 'share_links.create'] },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(await capabilities(holder)).toEqual(
      expect.arrayContaining(['data.export', 'share_links.create']),
    )

    const listed = (await call(fx.app, { url: '/roles', as: fx.admin })).json().items as Array<{
      id: string
      isSystem: boolean
      userCount: number
    }>
    expect(listed.find((role) => role.id === id)).toMatchObject({ isSystem: false, userCount: 1 })
  })

  it('держатель roles.manage собирает роль только из своих способностей, без привилегированных', async () => {
    const manager = await createRole(fx.admin, `Менеджер ролей ${run}`, [
      'roles.manage',
      'users.manage',
      'data.export',
    ])
    const managerKey = manager.json().key as string
    const lead = await createUser(fx.app, `role_lead_${run}`)
    await assign(lead.id, ['employee', managerKey])

    expect((await createRole(lead, `Своя ${run}`, ['data.export'])).statusCode).toBe(200)
    expect((await createRole(lead, `Чужая ${run}`, ['data.sql'])).statusCode).toBe(403)
    expect((await createRole(lead, `Аудит ${run}`, ['admin.audit.read'])).statusCode).toBe(403)

    // Роль с привилегированной способностью заводит администратор, а назначает — тоже только он
    const auditing = await createRole(fx.admin, `Аудит журнала ${run}`, ['admin.audit.read'])
    expect(auditing.statusCode, auditing.body).toBe(200)
    const employee = await createUser(fx.app, `role_target_${run}`)
    const escalation = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: lead,
      payload: { roleKeys: ['employee', auditing.json().key] },
    })
    expect(escalation.statusCode).toBe(403)
    const editing = await call(fx.app, {
      method: 'PATCH',
      url: `/roles/${auditing.json().id}`,
      as: lead,
      payload: { name: { ru: 'Переименована' } },
    })
    expect(editing.statusCode).toBe(403)
  })

  it('администрирование системы — только у системной роли; системную не меняют; назначенную не удалить', async () => {
    expect((await createRole(fx.admin, `Второй админ ${run}`, ['admin.system'])).statusCode).toBe(
      400,
    )

    const roles = (await call(fx.app, { url: '/roles', as: fx.admin })).json().items as Array<{
      id: string
      key: string
    }>
    const employeeRole = roles.find((role) => role.key === 'employee')
    const systemPatch = await call(fx.app, {
      method: 'PATCH',
      url: `/roles/${employeeRole?.id}`,
      as: fx.admin,
      payload: { capabilities: ['data.export'] },
    })
    expect(systemPatch.statusCode).toBe(400)

    const created = await createRole(fx.admin, `Временная ${run}`, ['ai.use'])
    const { id, key } = created.json() as { id: string; key: string }
    const holder = await createUser(fx.app, `role_temp_${run}`)
    await assign(holder.id, ['employee', key])
    const busy = await call(fx.app, { method: 'DELETE', url: `/roles/${id}`, as: fx.admin })
    expect(busy.statusCode).toBe(409)

    await assign(holder.id, ['employee'])
    const removed = await call(fx.app, { method: 'DELETE', url: `/roles/${id}`, as: fx.admin })
    expect(removed.statusCode, removed.body).toBe(200)

    const audit = await call(fx.app, {
      url: '/admin/audit?action=role.deleted&limit=20',
      as: fx.admin,
    })
    expect(
      (audit.json().items as Array<{ objectId: string | null }>).some(
        (item) => item.objectId === id,
      ),
    ).toBe(true)
  })
})
