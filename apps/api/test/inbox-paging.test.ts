import { beforeAll, describe, expect, it } from 'vitest'
import { call, createUser, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Постраничность Входящих (02-platform-kernel.md §Входящие): список отсортирован
 * по важности, сроку и времени, и курсор обязан повторять этот порядок целиком —
 * иначе дела со следующей страницы теряются (так пропадали резолюции у
 * руководителя с полусотней дел).
 */
registerLifecycle()

const { InboxService } = await import('../src/kernel/inbox/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { db } = await import('../src/shared/db/client.js')

const run = Date.now().toString(36)
let fx: TestContext
let user: Awaited<ReturnType<typeof createUser>>

const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const
const TOTAL = 25

beforeAll(async () => {
  fx = await setupFixture()
  user = await createUser(fx.app, `paging_${run}`, ['employee'])

  await db().transaction(async (tx) => {
    for (let index = 0; index < TOTAL; index += 1) {
      await InboxService.open(tx, systemCtx('test'), {
        userId: user.id,
        kind: 'review_page',
        titleKey: 'inbox.tpl.reviewPage',
        params: { title: `Дело ${index} ${run}` },
        // Каждое дело своё: без ключа они схлопнулись бы в одно
        dedupeKey: `paging-${run}-${index}`,
        // Вперемешку: важность и срок задают порядок, а не время создания
        priority: PRIORITIES[index % PRIORITIES.length],
        ...(index % 3 === 0
          ? { dueAt: new Date(Date.now() + index * 3_600_000).toISOString() }
          : {}),
      })
    }
  })
})

describe('страницы Входящих', () => {
  it('курсор проходит весь список без потерь и повторов', async () => {
    const seen: string[] = []
    let cursor: string | null = null

    for (let page = 0; page < 10; page += 1) {
      const url = `/inbox?state=open&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const response = await call(fx.app, { url, as: user })
      expect(response.statusCode, response.body).toBe(200)
      const body = response.json() as { items: Array<{ id: string }>; nextCursor: string | null }
      seen.push(...body.items.map((item) => item.id))
      cursor = body.nextCursor
      if (!cursor) break
    }

    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen).size, 'повторов между страницами нет').toBe(TOTAL)

    // Порядок постраничной выдачи совпадает с выдачей одним куском
    const whole = await call(fx.app, { url: `/inbox?state=open&limit=100`, as: user })
    expect(whole.statusCode, whole.body).toBe(200)
    const order = (whole.json().items as Array<{ id: string }>).map((item) => item.id)
    expect(seen).toEqual(order)
  })

  it('чужой или испорченный курсор показывает первую страницу, а не ошибку', async () => {
    const response = await call(fx.app, { url: '/inbox?state=open&limit=5&cursor=%20', as: user })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().items).toHaveLength(5)
  })
})
