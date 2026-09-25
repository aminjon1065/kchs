import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Оргструктура из консоли (N86): группы — создание, переименование, состав с записью
 * в аудит, системные не правятся; должности — правка и удаление только свободной;
 * основное назначение сотрудника — подразделение и должность.
 */
registerLifecycle()

const { employments, groups } = await import('../src/shared/db/schema/index.js')
const { computePrincipalSet } = await import('../src/kernel/access/principal-set.js')
const { newId } = await import('../src/shared/ids.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function auditHas(action: string, objectId: string): Promise<boolean> {
  const response = await call(fx.app, {
    url: `/admin/audit?action=${action}&limit=20`,
    as: fx.admin,
  })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().items as Array<{ objectId: string | null }>).some(
    (item) => item.objectId === objectId,
  )
}

describe('группы в консоли', () => {
  it('создаются, переименовываются, состав задаётся и читается, смена состава — в аудите', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/groups',
      as: fx.admin,
      payload: { name: `Дежурная смена ${run}`, description: 'Оперативные дежурные' },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/groups/${id}`,
      as: fx.admin,
      payload: { name: `Навбатдорон ${run}` },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)

    const first = await createUser(fx.app, `grp_a_${run}`)
    const second = await createUser(fx.app, `grp_b_${run}`)
    const set = await call(fx.app, {
      method: 'PUT',
      url: `/groups/${id}/members`,
      as: fx.admin,
      payload: { userIds: [first.id, second.id] },
    })
    expect(set.statusCode, set.body).toBe(200)

    const members = await call(fx.app, { url: `/groups/${id}/members`, as: fx.admin })
    expect(members.statusCode, members.body).toBe(200)
    expect((members.json().items as Array<{ id: string }>).map((u) => u.id).sort()).toEqual(
      [first.id, second.id].sort(),
    )
    const listed = (await call(fx.app, { url: '/groups', as: fx.admin })).json().items as Array<{
      id: string
      name: string
      memberCount: number
    }>
    expect(listed.find((item) => item.id === id)).toMatchObject({
      name: `Навбатдорон ${run}`,
      memberCount: 2,
    })
    expect(await auditHas('group.members_changed', id)).toBe(true)
    expect(await auditHas('group.updated', id)).toBe(true)
  })

  it('посторонний состав не читает и не меняет; системная группа не правится', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/groups',
      as: fx.admin,
      payload: { name: `Закрытая ${run}` },
    })
    const id = created.json().id as string
    expect(
      (await call(fx.app, { url: `/groups/${id}/members`, as: fx.users.member })).statusCode,
    ).toBe(403)
    expect(
      (
        await call(fx.app, {
          method: 'PUT',
          url: `/groups/${id}/members`,
          as: fx.users.member,
          payload: { userIds: [fx.users.member.id] },
        })
      ).statusCode,
    ).toBe(403)

    const system = newId()
    await db()
      .insert(groups)
      .values({ id: system, name: `Все ${run}`, kind: 'system' })
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: `/groups/${system}`,
      as: fx.admin,
      payload: { name: 'Другое' },
    })
    expect(patch.statusCode).toBe(400)
    const members = await call(fx.app, {
      method: 'PUT',
      url: `/groups/${system}/members`,
      as: fx.admin,
      payload: { userIds: [] },
    })
    expect(members.statusCode).toBe(400)
    await db().delete(groups).where(eq(groups.id, system))
  })
})

describe('должности и назначение в консоли', () => {
  it('должность правится, занятую не удалить, свободную — можно; назначение сотрудника', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/org/positions',
      as: fx.admin,
      payload: { name: { ru: `Дежурный ${run}` }, rank: 20 },
    })
    expect(created.statusCode, created.body).toBe(200)
    const positionId = created.json().id as string
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/org/positions/${positionId}`,
      as: fx.admin,
      payload: {
        name: { ru: `Оперативный дежурный ${run}`, tg: 'Навбатдори оперативӣ' },
        rank: 25,
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)

    const units = (await call(fx.app, { url: '/org/units', as: fx.admin })).json().items as Array<{
      id: string
    }>
    const employee = await createUser(fx.app, `assign_${run}`)
    const assigned = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: fx.admin,
      payload: { unitId: units[0]?.id, positionId },
    })
    expect(assigned.statusCode, assigned.body).toBe(200)

    const taken = await call(fx.app, {
      method: 'DELETE',
      url: `/org/positions/${positionId}`,
      as: fx.admin,
    })
    expect(taken.statusCode).toBe(409)

    const cleared = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: fx.admin,
      payload: { unitId: units[0]?.id, positionId: null },
    })
    expect(cleared.statusCode, cleared.body).toBe(200)
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/org/positions/${positionId}`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await auditHas('position.deleted', positionId)).toBe(true)
    const [left] = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM positions WHERE id = ${positionId}`,
    )
    expect(left?.count).toBe(0)
  })

  it('перевод закрывает прежнее назначение: доступа к прежнему подразделению не остаётся', async () => {
    const unit = async (code: string) =>
      (
        await call(fx.app, {
          method: 'POST',
          url: '/org/units',
          as: fx.admin,
          payload: { name: { ru: `Отдел ${code}` }, code, createSpace: false },
        })
      ).json().id as string
    const from = await unit(`FROM-${run}`)
    const to = await unit(`TO-${run}`)
    const employee = await createUser(fx.app, `transfer_${run}`, ['employee'], from)
    const principals = async () => (await computePrincipalSet(employee.id)).keys

    expect(await principals()).toContain(`unit:${from}`)
    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: fx.admin,
      payload: { unitId: to },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(await principals()).toContain(`unit:${to}`)
    expect(await principals()).not.toContain(`unit:${from}`)
    const listed = await call(fx.app, { url: `/users?unitId=${from}`, as: fx.admin })
    expect((listed.json().items as Array<{ id: string }>).map((u) => u.id)).not.toContain(
      employee.id,
    )
    const history = await db()
      .select({ unitId: employments.unitId, endsAt: employments.endsAt })
      .from(employments)
      .where(eq(employments.userId, employee.id))
    expect(history).toHaveLength(2)
    expect(history.find((row) => row.unitId === from)?.endsAt).not.toBeNull()
    expect(await auditHas('user.employment_changed', employee.id)).toBe(true)

    // Снятие с подразделения — доступа нет ни к какому; должность без подразделения — ошибка
    const orphan = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: fx.admin,
      payload: { unitId: null },
    })
    expect(orphan.statusCode, orphan.body).toBe(200)
    expect((await principals()).filter((p) => p.startsWith('unit:'))).toEqual([])
    const position = await call(fx.app, {
      method: 'POST',
      url: '/org/positions',
      as: fx.admin,
      payload: { name: { ru: `Инспектор ${run}` }, rank: 10 },
    })
    const positionOnly = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${employee.id}`,
      as: fx.admin,
      payload: { positionId: position.json().id },
    })
    expect(positionOnly.statusCode, positionOnly.body).toBe(400)
  })
})
