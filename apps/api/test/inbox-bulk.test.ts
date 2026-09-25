import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Входящие (ADR-0153): фильтр по группе дел и массовые действия — «Ознакомлен» и
 * «Отметить выполненным» идут через модули дел по одному, неподходящие пропускаются,
 * «Отложить» — всем открытым из выбранных; чужие дела не трогаются.
 */
registerLifecycle()

const { InboxService } = await import('../src/kernel/inbox/service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { newId } = await import('../src/shared/ids.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function fileId(name: string): Promise<string> {
  const file = await uploadFile(fx.app, fx.admin, {
    spaceId: fx.spaceId,
    name: `${name} ${run}.txt`,
    content: Buffer.from(name),
    mime: 'text/plain',
  })
  return file.id
}

async function openItem(input: Parameters<typeof InboxService.open>[2]): Promise<string> {
  await db().transaction((tx) => InboxService.open(tx, systemCtx('test'), input))
  const items = await listFor(fx.users.member)
  const found = items.find((item) => item.payload.marker === input.payload?.marker)
  if (!found) throw new Error(`дело ${String(input.payload?.marker)} не открылось`)
  return found.id
}

async function listFor(user: TestUser, query = '') {
  const response = await call(fx.app, { url: `/inbox?limit=100${query}`, as: user })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items as Array<{
    id: string
    kind: string
    payload: Record<string, unknown>
  }>
}

const ACKNOWLEDGE = [
  {
    key: 'acknowledge',
    labelKey: 'inbox.actions.acknowledge',
    variant: 'primary' as const,
    requiresComment: false,
  },
]

describe('входящие: группы и массовые действия', () => {
  it('фильтр по группе и «Ознакомлен» пачкой — неподходящие пропускаются', async () => {
    const [first, second, third] = await Promise.all([
      fileId('Отчёт А'),
      fileId('Отчёт Б'),
      fileId('На согласование'),
    ])
    const reportA = await openItem({
      userId: fx.users.member.id,
      kind: 'report',
      objectId: first,
      titleKey: 'inbox.tpl.report',
      payload: { marker: `report-a-${run}` },
      actions: ACKNOWLEDGE,
    })
    const reportB = await openItem({
      userId: fx.users.member.id,
      kind: 'report',
      objectId: second,
      titleKey: 'inbox.tpl.report',
      payload: { marker: `report-b-${run}` },
      actions: ACKNOWLEDGE,
    })
    const approve = await openItem({
      userId: fx.users.member.id,
      kind: 'approve',
      objectId: third,
      titleKey: 'inbox.tpl.approve',
      payload: { marker: `approve-${run}` },
    })

    const acknowledgeGroup = (await listFor(fx.users.member, '&group=acknowledge')).map((i) => i.id)
    expect(acknowledgeGroup).toEqual(expect.arrayContaining([reportA, reportB]))
    expect(acknowledgeGroup).not.toContain(approve)

    const bulk = await call(fx.app, {
      method: 'POST',
      url: '/inbox/bulk',
      as: fx.users.member,
      payload: { ids: [reportA, reportB, approve], operation: 'acknowledge' },
    })
    expect(bulk.statusCode, bulk.body).toBe(200)
    expect(bulk.json()).toMatchObject({ done: 2, skipped: 1 })
    expect(
      (bulk.json().results as Array<{ id: string; reason: string | null }>).find(
        (result) => result.id === approve,
      )?.reason,
    ).toBe('not_applicable')
    const open = (await listFor(fx.users.member)).map((item) => item.id)
    expect(open).not.toContain(reportA)
    expect(open).not.toContain(reportB)
    expect(open).toContain(approve)

    // Чужое дело посторонний ни отложить, ни закрыть не может
    const foreign = await call(fx.app, {
      method: 'POST',
      url: '/inbox/bulk',
      as: fx.users.stranger,
      payload: { ids: [approve], operation: 'snooze' },
    })
    expect(foreign.json()).toMatchObject({ done: 0, skipped: 1 })

    const snoozed = await call(fx.app, {
      method: 'POST',
      url: '/inbox/bulk',
      as: fx.users.member,
      payload: { ids: [approve], operation: 'snooze' },
    })
    expect(snoozed.json()).toMatchObject({ done: 1, skipped: 0 })
    expect((await listFor(fx.users.member)).map((item) => item.id)).not.toContain(approve)
  })

  it('«Отметить выполненным» закрывает алерт его же действием «Разобрался»', async () => {
    const eventId = newId()
    const alert = await openItem({
      userId: fx.users.member.id,
      kind: 'alert',
      titleKey: 'inbox.tpl.alert',
      dedupeKey: `alert:${eventId}`,
      payload: { marker: `alert-${run}`, eventId },
      actions: [
        {
          key: 'dismiss',
          labelKey: 'inbox.actions.dismissAlert',
          variant: 'primary',
          requiresComment: false,
        },
      ],
    })
    expect((await listFor(fx.users.member, '&group=data')).map((item) => item.id)).toContain(alert)

    const done = await call(fx.app, {
      method: 'POST',
      url: '/inbox/bulk',
      as: fx.users.member,
      payload: { ids: [alert], operation: 'done' },
    })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({ done: 1, skipped: 0 })
    expect((await listFor(fx.users.member)).map((item) => item.id)).not.toContain(alert)
  })
})
