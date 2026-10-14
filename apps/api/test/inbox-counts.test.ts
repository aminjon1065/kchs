import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture, type TestContext, uploadFile } from './helpers.js'

/**
 * Счётчики Входящих пересчитываются после коммита (ADR-0222): новый срок дела внутри
 * транзакции ещё не виден другим соединениям, и пересчёт до коммита закешировал бы
 * прежнее «просрочено» — человек видел бы устаревший счётчик до истечения кэша.
 */
registerLifecycle()

const { InboxService, invalidateCounts } = await import('../src/kernel/inbox/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

describe('счётчики Входящих', () => {
  it('новый срок дела: «просрочено» верно сразу после коммита', async () => {
    const user = fx.users.viewer
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `Срок ${run}.txt`,
      content: Buffer.from('срок'),
      mime: 'text/plain',
    })
    await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: user.id,
        kind: 'approve',
        objectId: file.id,
        titleKey: 'inbox.tpl.approve',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    )
    await invalidateCounts([user.id])
    const before = await InboxService.counts(user.id)

    const past = new Date(Date.now() - 3_600_000).toISOString()
    await db().transaction((tx) => InboxService.setDue(tx, { objectId: file.id }, past))

    const after = await InboxService.counts(user.id)
    expect(after.overdue, 'кэш не хранит счётчик, посчитанный до коммита').toBe(before.overdue + 1)
  })

  it('пересчёт многим пользователям — каждому свой счётчик', async () => {
    const users = [fx.users.member, fx.users.viewer, fx.users.stranger, fx.admin]
    await invalidateCounts([...users.map((user) => user.id), fx.users.member.id])
    for (const user of users) {
      const cached = await InboxService.counts(user.id)
      await invalidateCounts([user.id])
      expect(await InboxService.counts(user.id)).toEqual(cached)
    }
  })
})
