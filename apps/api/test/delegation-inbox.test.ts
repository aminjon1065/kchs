import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Замещение и «Входящие» (ADR-0229): начало замещения открывает заместителю копии уже
 * ждущих дел отсутствующего в пределах области, окончание и отмена — закрывают их;
 * запланированное замещение видно и отменяемо; кадры назначают заместителя за сотрудника.
 */
registerLifecycle()

const { InboxService } = await import('../src/kernel/inbox/service.js')
const { DelegationService } = await import('../src/kernel/directory/delegation-service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let run = 0

beforeAll(async () => {
  fx = await setupFixture()
  const { listSubscribers } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((s) => s.name === 'kernel-inbox-delegations')) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
})

/** Доставить подписчику замещений события замещения `delegationId` из outbox. */
async function deliverDelegationEvents(delegationId: string): Promise<void> {
  const { listSubscribers } = await import('../src/kernel/events/bus.js')
  const subscriber = listSubscribers().find((s) => s.name === 'kernel-inbox-delegations')
  if (!subscriber) throw new Error('подписчик замещений не зарегистрирован')
  const rows = await db().execute<{ id: number; event: unknown }>(sql`
    SELECT id, event FROM ops.outbox
     WHERE type IN ('delegation.started', 'delegation.ended')
       AND event->'object'->>'id' = ${delegationId} AND published_at IS NULL
     ORDER BY id`)
  for (const row of rows) {
    await subscriber.handle(row.event as never)
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

async function pair(): Promise<{ absent: TestUser; deputy: TestUser }> {
  run += 1
  const stamp = `${Date.now()}_${run}`
  return {
    absent: await createUser(fx.app, `absent_${stamp}`, ['employee']),
    deputy: await createUser(fx.app, `deputy_${stamp}`, ['employee']),
  }
}

async function folder(title: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name: title, spaceId: fx.spaceId },
  })
  return response.json().id as string
}

async function openItem(userId: string, kind: string, objectId: string): Promise<void> {
  await db().transaction((tx) =>
    InboxService.open(tx, systemCtx('test'), {
      userId,
      kind: kind as never,
      objectId,
      titleKey: `inbox.kind.${kind}`,
    }),
  )
}

async function copiesOf(deputyId: string, absentId: string): Promise<string[]> {
  const rows = await db().execute<{ kind: string }>(sql`
    SELECT kind FROM inbox_items
     WHERE user_id = ${deputyId} AND on_behalf_of = ${absentId} AND state IN ('open', 'snoozed')
     ORDER BY kind`)
  return rows.map((row) => row.kind)
}

async function delegate(absent: TestUser, deputy: TestUser, scope: string, startsIn = -60_000) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/delegations',
    as: absent,
    payload: {
      toUserId: deputy.id,
      scope,
      startsAt: new Date(Date.now() + startsIn).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

describe('замещение и «Входящие»', () => {
  it('заместитель получает уже ждущие дела в пределах области, по окончании они закрываются', async () => {
    const { absent, deputy } = await pair()
    await openItem(absent.id, 'resolve', await folder(`Резолюция ${run}`))
    await openItem(absent.id, 'respond_invite', await folder(`Приглашение ${run}`))

    const id = await delegate(absent, deputy, 'documents')
    await deliverDelegationEvents(id)
    // Область «документы»: резолюция — да, приглашение на встречу — нет
    expect(await copiesOf(deputy.id, absent.id)).toEqual(['resolve'])

    const stopped = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${id}`,
      as: absent,
    })
    expect(stopped.statusCode).toBe(200)
    await deliverDelegationEvents(id)
    expect(await copiesOf(deputy.id, absent.id)).toEqual([])
  })

  it('истёкшее по дате замещение закрывает копии, начавшееся по дате — открывает', async () => {
    const { absent, deputy } = await pair()
    await openItem(absent.id, 'acknowledge', await folder(`Ознакомление ${run}`))

    // Запланировано на будущее: копий пока нет
    const id = await delegate(absent, deputy, 'all', 3_600_000)
    await deliverDelegationEvents(id)
    expect(await copiesOf(deputy.id, absent.id)).toEqual([])

    // Наступила дата начала — задание сверки открывает копии
    await db().execute(
      sql`UPDATE delegations SET starts_at = now() - interval '1 minute' WHERE id = ${id}`,
    )
    for (const p of await DelegationService.effectivePairs()) {
      if (p.fromUserId !== absent.id) continue
      await db().transaction((tx) =>
        InboxService.syncDeputyCopies(tx, systemCtx('test'), p.fromUserId, p.toUserId),
      )
    }
    expect(await copiesOf(deputy.id, absent.id)).toEqual(['acknowledge'])

    // Срок вышел — замещение закрывается событием, копии — подписчиком
    await db().execute(
      sql`UPDATE delegations SET ends_at = now() - interval '1 second' WHERE id = ${id}`,
    )
    const expired = await DelegationService.expireDue()
    expect(expired.some((p) => p.fromUserId === absent.id)).toBe(true)
    await deliverDelegationEvents(id)
    expect(await copiesOf(deputy.id, absent.id)).toEqual([])
  })

  it('запланированное замещение видно в профиле и отменяется', async () => {
    const { absent, deputy } = await pair()
    const id = await delegate(absent, deputy, 'all', 86_400_000)
    const listed = await call(fx.app, { url: '/me/delegations', as: absent })
    const item = listed.json().items.find((entry: { id: string }) => entry.id === id)
    expect(item?.upcoming).toBe(true)

    const cancelled = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${id}`,
      as: absent,
    })
    expect(cancelled.statusCode).toBe(200)
    const after = await call(fx.app, { url: '/me/delegations', as: absent })
    expect(after.json().items.some((entry: { id: string }) => entry.id === id)).toBe(false)
    const [row] = await db().execute<{ status: string }>(
      sql`SELECT status FROM delegations WHERE id = ${id}`,
    )
    expect(row?.status).toBe('cancelled')
  })

  it('кадры назначают заместителя за сотрудника; рядовой сотрудник — нет', async () => {
    const { absent, deputy } = await pair()
    const payload = {
      toUserId: deputy.id,
      scope: 'all',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/users/${absent.id}/delegations`,
      as: fx.users.member,
      payload,
    })
    expect(denied.statusCode).toBe(403)

    const assigned = await call(fx.app, {
      method: 'POST',
      url: `/users/${absent.id}/delegations`,
      as: fx.admin,
      payload,
    })
    expect(assigned.statusCode, assigned.body).toBe(200)
    const id = assigned.json().id as string
    const listed = await call(fx.app, { url: `/users/${absent.id}/delegations`, as: fx.admin })
    expect(listed.json().items.map((entry: { id: string }) => entry.id)).toContain(id)

    // Заместитель действует от имени отсутствующего; отменить может и администратор
    await redis().del(`kchs:principals:${deputy.id}`)
    const acting = await call(fx.app, {
      url: '/me',
      as: deputy,
      headers: { 'x-kchs-on-behalf-of': absent.id },
    })
    expect(acting.json().session.onBehalfOf).toBe(absent.id)
    const stopped = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${id}`,
      as: fx.admin,
    })
    expect(stopped.statusCode).toBe(200)
  })
})
