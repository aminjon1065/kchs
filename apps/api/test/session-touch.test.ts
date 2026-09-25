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
 * Отметка активности сессии пишется не на каждый запрос, а не чаще раза в минуту: простой
 * сессии считается по ней с точностью до минуты.
 */
registerLifecycle()

const { sessions } = await import('../src/shared/db/schema/index.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

const lastActive = async (userId: string) => {
  const [row] = await db()
    .select({ at: sessions.lastActiveAt })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .limit(1)
  return row?.at
}

describe('отметка активности сессии', () => {
  it('свежая отметка не переписывается, старше минуты — обновляется', async () => {
    const user = await createUser(fx.app, `touch_${Date.now().toString(36)}`)
    await db()
      .update(sessions)
      .set({ lastActiveAt: sql`now() - interval '10 seconds'` })
      .where(eq(sessions.userId, user.id))
    const fresh = await lastActive(user.id)
    expect((await call(fx.app, { url: '/me', as: user })).statusCode).toBe(200)
    // Отметка пишется без ожидания ответа — даём ей время
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await lastActive(user.id)).toBe(fresh)

    await db()
      .update(sessions)
      .set({ lastActiveAt: sql`now() - interval '2 minutes'` })
      .where(eq(sessions.userId, user.id))
    const stale = await lastActive(user.id)
    expect((await call(fx.app, { url: '/me', as: user })).statusCode).toBe(200)
    await expect.poll(async () => lastActive(user.id), { timeout: 3000 }).not.toBe(stale)
  })
})
