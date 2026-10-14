import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Вложение получает права от хостов не выше edit (09-files.md §1). Проверка доступа
 * прекращает перебор хостов, как только этот уровень достигнут; «Объяснить доступ»
 * по-прежнему перечисляет каждый хост (ADR-0220).
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { authorize } = await import('../src/kernel/access/authorize.js')
const { buildUserCtxFor } = await import('../src/kernel/access/explain.js')

let fx: TestContext
let attachmentId: string

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test', { initiatorId: fx.admin.id })
  const [first, second, attachment] = await db().transaction(async (tx) => {
    const created = []
    for (const title of ['Хост 1', 'Хост 2', 'Вложение']) {
      created.push(
        await ObjectService.create(tx, ctx, { type: 'folder', spaceId: fx.spaceId, title }),
      )
    }
    return created
  })
  if (!first || !second || !attachment) throw new Error('объекты не созданы')
  attachmentId = attachment.id
  for (const host of [first, second]) {
    const linked = await call(fx.app, {
      method: 'POST',
      url: `/objects/${host.id}/links`,
      as: fx.admin,
      payload: { targetId: attachment.id, kind: 'attachment' },
    })
    expect(linked.statusCode, linked.body).toBe(200)
    const granted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${host.id}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'edit' }],
      },
    })
    expect(granted.statusCode, granted.body).toBe(200)
  }
})

const attachmentReasons = (reasons: { kind: string }[]) =>
  reasons.filter((item) => item.kind === 'attachment').length

describe('права вложения от хостов', () => {
  it('проверка доступа останавливается на первом хосте с уровнем edit', async () => {
    const ctx = await buildUserCtxFor(fx.users.stranger.id)
    if (!ctx) throw new Error('нет пользователя')
    const decision = await authorize(ctx, 'edit', attachmentId)
    expect(decision.level).toBe('edit')
    expect(attachmentReasons(decision.reasons)).toBe(1)
  })

  it('«Объяснить доступ» перечисляет оба хоста', async () => {
    const explain = await call(fx.app, {
      method: 'POST',
      url: `/objects/${attachmentId}/access/explain`,
      as: fx.admin,
      payload: { userId: fx.users.stranger.id },
    })
    expect(explain.statusCode, explain.body).toBe(200)
    expect(explain.json().level).toBe('edit')
    expect(attachmentReasons(explain.json().reasons)).toBe(2)
  })
})
