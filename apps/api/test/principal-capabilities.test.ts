import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Способности ролей живут в кэше набора принципалов (ADR-0220): запрос больше не читает
 * их из базы каждый раз. Правка способностей роли и назначение роли видны уже следующему
 * запросу — набор сбрасывается, как и при смене членства.
 */
registerLifecycle()

const { buildUserCtx } = await import('../src/kernel/context-builder.js')

let fx: TestContext
const request = { headers: {}, id: 'test', ip: '127.0.0.1' } as never

beforeAll(async () => {
  fx = await setupFixture()
})

const capabilitiesOf = async (userId: string) =>
  (
    await buildUserCtx(
      { sessionId: 'session', userId, onBehalfOf: null, mfaEnrolled: true },
      request,
    )
  ).capabilities

describe('способности из кэша набора принципалов', () => {
  it('назначение роли и правка её способностей видны следующему запросу', async () => {
    const member = fx.users.member
    expect((await capabilitiesOf(member.id)).has('data.export')).toBe(false)

    const key = `cap_${Date.now().toString(36)}`
    const created = await call(fx.app, {
      method: 'POST',
      url: '/roles',
      as: fx.admin,
      payload: { key, name: { ru: 'Проверка кэша' }, capabilities: ['data.export'] },
    })
    expect(created.statusCode, created.body).toBe(200)
    const roleId = created.json().id as string

    const assigned = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${member.id}`,
      as: fx.admin,
      payload: { roleKeys: ['employee', key] },
    })
    expect(assigned.statusCode, assigned.body).toBe(200)
    expect((await capabilitiesOf(member.id)).has('data.export')).toBe(true)

    // Способность роли сменилась — набор из кэша её больше не отдаёт
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/roles/${roleId}`,
      as: fx.admin,
      payload: { capabilities: ['data.sql'] },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const after = await capabilitiesOf(member.id)
    expect(after.has('data.export')).toBe(false)
    expect(after.has('data.sql')).toBe(true)
  })
})
