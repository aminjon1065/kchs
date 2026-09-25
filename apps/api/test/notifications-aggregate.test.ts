import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Агрегация уведомлений (12-calendar-notifications-home.md): несколько событий одного
 * объекта за 5 минут — одна строка «N изменений в …». Срочное не агрегируется (ADR-0168):
 * каждая тревога видна дежурному своим текстом.
 */
registerLifecycle()

const { NotificationService } = await import('../src/kernel/notifications/service.js')
const { notifications } = await import('../src/shared/db/schema/index.js')

const run = Date.now().toString(36)
let fx: TestContext

async function rowsOf(key: string) {
  return db()
    .select({ count: notifications.aggregateCount, params: notifications.params })
    .from(notifications)
    .where(sql`${notifications.aggregateKey} = ${key}`)
}

beforeAll(async () => {
  fx = await setupFixture()
})

describe('агрегация уведомлений', () => {
  it('обычные правки одного объекта — одна строка со счётчиком', async () => {
    const key = `правки-${run}`
    for (const text of ['первая правка', 'вторая правка']) {
      await NotificationService.notify({
        userIds: [fx.users.member.id],
        category: 'data',
        titleKey: 'notifications.tpl.automation',
        params: { text },
        objectId: fx.spaceId,
        aggregateKey: key,
      })
    }
    const rows = await rowsOf(key)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.count).toBe(2)
  })

  it('срочные — каждая своей строкой и своим текстом', async () => {
    const key = `тревоги-${run}`
    for (const text of ['Землетрясение M4,7 в Мургабе', 'Сель в Варзобе']) {
      await NotificationService.notify({
        userIds: [fx.users.member.id],
        category: 'data',
        titleKey: 'notifications.tpl.automation',
        params: { text },
        objectId: fx.spaceId,
        aggregateKey: key,
        urgent: true,
      })
    }
    const rows = await rowsOf(key)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.count)).toEqual([1, 1])
    expect(rows.map((row) => (row.params as { text: string }).text).sort()).toEqual([
      'Землетрясение M4,7 в Мургабе',
      'Сель в Варзобе',
    ])
  })
})
