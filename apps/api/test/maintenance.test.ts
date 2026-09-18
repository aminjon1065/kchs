import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/** Задания обслуживания ядра (02-platform-kernel.md §9). */
registerLifecycle()

const { RECENT_LIMIT, trimRecentViews } = await import('../src/kernel/objects/service.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

describe('недавние', () => {
  it(`обрезаются до ${RECENT_LIMIT} на пользователя, остаются самые свежие`, async () => {
    // 205 просмотров администратора (i-й — i минут назад) и 3 — участника
    await db().execute(sql`
      WITH created AS (
        INSERT INTO objects (id, type, space_id, title, owner_id)
        SELECT gen_random_uuid(), 'folder', ${fx.spaceId}::uuid, 'Недавний ' || n, ${fx.admin.id}::uuid
          FROM generate_series(1, 205) AS n
        RETURNING id, title
      )
      INSERT INTO recent_views (user_id, object_id, viewed_at)
      SELECT ${fx.admin.id}::uuid, id,
             now() - make_interval(mins => substring(title FROM '\\d+')::int)
        FROM created
      UNION ALL
      SELECT ${fx.users.member.id}::uuid, id, now()
        FROM created WHERE substring(title FROM '\\d+')::int <= 3
    `)

    const deleted = await trimRecentViews()
    expect(deleted).toBe(5)

    const [admin] = await db().execute<{ count: number; oldest: number }>(sql`
      SELECT count(*)::int AS count,
             max(substring(o.title FROM '\\d+')::int) AS oldest
        FROM recent_views rv JOIN objects o ON o.id = rv.object_id
       WHERE rv.user_id = ${fx.admin.id}`)
    expect(admin).toEqual({ count: RECENT_LIMIT, oldest: RECENT_LIMIT })

    const [member] = await db().execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM recent_views WHERE user_id = ${fx.users.member.id}`)
    expect(member?.count).toBe(3)
  })
})
