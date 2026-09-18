import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * P0-E06 S02: список объектов пространства фильтруется предикатом видимости на
 * уровне SQL; на 10 тыс. объектов ответ укладывается в 100 мс. Дерево —
 * 100 папок по 99 вложенных, каждая десятая папка закрыта (restricted) с явной
 * записью участника: предикат проверяет и ACL предков, и границу наследования.
 */
registerLifecycle()

let fx: TestContext
// Критерий — 100 мс на стенде; общие раннеры CI примерно вдвое медленнее
const BUDGET_MS = process.env.CI ? 250 : 100

beforeAll(async () => {
  fx = await setupFixture()
  await db().execute(sql`
    WITH parents AS (
      INSERT INTO objects (id, type, space_id, parent_id, title, owner_id, access_mode)
      SELECT gen_random_uuid(), 'folder', ${fx.spaceId}::uuid, NULL,
             'Нагрузка ' || n, ${fx.admin.id}::uuid,
             CASE WHEN n % 10 = 0 THEN 'restricted' ELSE 'inherit' END
        FROM generate_series(1, 100) AS n
      RETURNING id, access_mode
    ), children AS (
      INSERT INTO objects (id, type, space_id, parent_id, title, owner_id)
      SELECT gen_random_uuid(), 'folder', ${fx.spaceId}::uuid, p.id,
             'Вложенная ' || n, ${fx.admin.id}::uuid
        FROM parents p, generate_series(1, 99) AS n
      RETURNING id, parent_id
    ), closure AS (
      INSERT INTO object_ancestors (object_id, ancestor_id, depth)
      SELECT id, parent_id, 1 FROM children
    )
    INSERT INTO acl_entries (id, object_id, principal_type, principal_id, level)
    SELECT gen_random_uuid(), p.id, 'user', ${fx.users.member.id}, 20
      FROM parents p WHERE p.access_mode = 'restricted'
  `)
  await db().execute(sql`ANALYZE objects; ANALYZE object_ancestors; ANALYZE acl_entries`)
})

async function median(url: string, as: TestContext['admin']): Promise<number> {
  const timings: number[] = []
  for (let i = 0; i < 7; i++) {
    const started = performance.now()
    const response = await call(fx.app, { url, as })
    timings.push(performance.now() - started)
    expect(response.statusCode).toBe(200)
  }
  timings.sort((a, b) => a - b)
  return timings[Math.floor(timings.length / 2)] ?? Number.POSITIVE_INFINITY
}

describe('производительность предиката видимости', () => {
  it('список пространства на 10 тыс. объектов укладывается в бюджет', async () => {
    const url = `/objects?spaceId=${fx.spaceId}&type=folder&limit=50`
    const member = await median(url, fx.users.member)
    const viewer = await median(url, fx.users.viewer)
    const outsider = await median(url, fx.users.stranger)
    const inside = await median(
      `/objects?spaceId=${fx.spaceId}&type=folder&q=${encodeURIComponent('Вложенная 5')}&limit=50`,
      fx.users.viewer,
    )
    console.info(
      `видимость, мс: участник ${member.toFixed(1)}, читатель ${viewer.toFixed(1)}, ` +
        `посторонний ${outsider.toFixed(1)}, поиск по названию ${inside.toFixed(1)}`,
    )
    for (const timing of [member, viewer, outsider, inside]) expect(timing).toBeLessThan(BUDGET_MS)
  })

  it('содержимое закрытых папок читателю пространства не видно', async () => {
    const response = await call(fx.app, {
      url: `/objects?spaceId=${fx.spaceId}&type=folder&q=${encodeURIComponent('Нагрузка 10')}&limit=50`,
      as: fx.users.viewer,
    })
    const titles = response.json().items.map((item: { title: string }) => item.title)
    // «Нагрузка 10» и «Нагрузка 100» закрыты; «Нагрузка 1…» открытые остаются
    expect(titles).not.toContain('Нагрузка 10')
    expect(titles).not.toContain('Нагрузка 100')
  })
})
