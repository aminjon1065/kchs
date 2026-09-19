import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Календарь (P3-E04, ADR-0081; сценарий приёмки фазы 3 №5): встреча с
 * повтором, приглашения во Входящих и ответы, правка «только это / это и
 * следующие / вся серия», бронь ресурса, напоминания без повторов, проекции
 * сроков поручений, ICS-подписка и импорт, подбор времени и видимость «личного».
 */
registerLifecycle()

const { dispatchDueReminders, planReminders } = await import(
  '../src/modules/calendar/domain/reminders.js'
)
const { indexObject } = await import('../src/kernel/search/index-service.js')

let fx: TestContext
const run = Date.now().toString(36)
const DAY = 86_400_000

/** Дата по Душанбе через `days` дней. */
function dushanbeDate(days: number): string {
  return new Date(Date.now() + 5 * 3_600_000 + days * DAY).toISOString().slice(0, 10)
}

/** Понедельник не раньше чем через `min` дней. */
function mondayAfter(min: number): string {
  for (let day = min; day < min + 7; day++) {
    const date = dushanbeDate(day)
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 1) return date
  }
  throw new Error('нет понедельника')
}

const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`).toISOString()
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

const monday = mondayAfter(8)

/** Подписчики ядра и календаря по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'kernel-notifications')) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
  if (!listSubscribers().some((subscriber) => subscriber.name === 'calendar-notifications')) {
    const { registerCalendarBackground } = await import('../src/modules/calendar/module.js')
    registerCalendarBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

async function personalCalendar(user: TestUser): Promise<{ id: string; color: string }> {
  const response = await call(fx.app, { url: '/calendars', as: user })
  expect(response.statusCode, response.body).toBe(200)
  const mine = (response.json().items as Array<{ id: string; mine: boolean; color: string }>).find(
    (item) => item.mine,
  )
  expect(mine).toBeDefined()
  return mine as { id: string; color: string }
}

async function range(user: TestUser, from: string, to: string, extra = '') {
  const response = await call(fx.app, {
    url: `/calendar/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`,
    as: user,
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as {
    items: Array<{
      key: string
      eventId: string | null
      busy: boolean
      title: string | null
      startsAt: string
      recurrenceId: string | null
      myStatus: string | null
      invitation: boolean
    }>
    projections: Array<{ provider: string; objectId: string; date: string }>
  }
}

async function inviteOf(user: TestUser, eventId: string) {
  const response = await call(fx.app, { url: '/inbox?kind=respond_invite', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (
    response.json().items as Array<{
      id: string
      object: { id: string } | null
      title: string
      actions: Array<{ key: string }>
    }>
  ).find((item) => item.object?.id === eventId)
}

async function notificationTitles(user: TestUser): Promise<string[]> {
  const response = await call(fx.app, { url: '/notifications?limit=100', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().items as Array<{ title: string }>).map((item) => item.title)
}

async function instanceCount(eventId: string): Promise<number> {
  const [row] = await db().execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM event_instances WHERE event_id = ${eventId}`,
  )
  return row?.count ?? 0
}

let roomId = ''
let seriesId = ''

beforeAll(async () => {
  fx = await setupFixture()
  const room = await call(fx.app, {
    method: 'POST',
    url: '/calendars',
    as: fx.admin,
    payload: {
      kind: 'resource',
      title: `Переговорная 305 ${run}`,
      spaceId: fx.orgSpaceId,
      resource: { kind: 'room', location: 'Третий этаж', capacity: 12 },
    },
  })
  expect(room.statusCode, room.body).toBe(200)
  roomId = room.json().id
})

describe('календари', () => {
  it('личный календарь создаётся при первом обращении, ресурс «Общего» виден всем', async () => {
    const mine = await personalCalendar(fx.users.member)
    const again = await personalCalendar(fx.users.member)
    expect(again.id).toBe(mine.id)

    const list = await call(fx.app, { url: '/calendars', as: fx.users.stranger })
    const items = list.json().items as Array<{ id: string; kind: string; can: { book: boolean } }>
    const room = items.find((item) => item.id === roomId)
    expect(room?.kind).toBe('resource')
    expect(room?.can.book).toBe(true)
  })

  it('командный календарь пространства видят его участники, посторонний — нет', async () => {
    const team = await call(fx.app, {
      method: 'POST',
      url: '/calendars',
      as: fx.admin,
      payload: { kind: 'team', title: `Штаб ${run}`, spaceId: fx.spaceId, color: 'teal' },
    })
    expect(team.statusCode, team.body).toBe(200)
    const teamId = team.json().id
    const viewer = await call(fx.app, { url: '/calendars', as: fx.users.viewer })
    expect(viewer.json().items.map((item: { id: string }) => item.id)).toContain(teamId)
    const viewerRecord = await call(fx.app, { url: `/calendars/${teamId}`, as: fx.users.viewer })
    expect(viewerRecord.json().can.edit).toBe(false)
    const member = await call(fx.app, { url: `/calendars/${teamId}`, as: fx.users.member })
    expect(member.json().can.edit).toBe(true)
    const stranger = await call(fx.app, { url: `/calendars/${teamId}`, as: fx.users.stranger })
    expect(stranger.statusCode).toBe(404)
  })
})

describe('встреча с повтором и приглашения', () => {
  it('серия материализуется, приглашённые получают дело во Входящих и уведомление', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: {
        title: `Планёрка ${run}`,
        startsAt: at(monday, '10:00'),
        endsAt: at(monday, '10:30'),
        rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
        attendees: [{ userId: fx.users.stranger.id }, { userId: fx.users.viewer.id }],
        resourceIds: [roomId],
        reminders: [{ minutes: 15, channels: ['app'] }],
        location: 'Зал 305',
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    seriesId = created.json().id
    expect(await instanceCount(seriesId)).toBe(10)

    const invite = await inviteOf(fx.users.stranger, seriesId)
    expect(invite?.actions.map((action) => action.key)).toEqual([
      'accepted',
      'tentative',
      'declined',
    ])
    expect(invite?.title).toContain(`Планёрка ${run}`)

    await drainOutbox()
    const titles = await notificationTitles(fx.users.stranger)
    expect(
      titles.some((title) => title.includes(`Планёрка ${run}`) && title.includes('приглашает')),
    ).toBe(true)

    // Приглашение видно в календаре приглашённого — в его личном
    const view = await range(
      fx.users.stranger,
      at(monday, '00:00'),
      at(addDays(monday, 7), '00:00'),
    )
    const item = view.items.find((entry) => entry.eventId === seriesId)
    expect(item?.invitation).toBe(true)
    expect(item?.myStatus).toBe('needs_action')
    expect(item?.recurrenceId).toBe(at(monday, '10:00'))
  })

  it('ответ из Входящих закрывает дело; организатор узнаёт об ответе', async () => {
    const invite = await inviteOf(fx.users.stranger, seriesId)
    const act = await call(fx.app, {
      method: 'POST',
      url: `/inbox/${invite?.id}/act`,
      as: fx.users.stranger,
      payload: { action: 'accepted' },
    })
    expect(act.statusCode, act.body).toBe(200)
    expect(await inviteOf(fx.users.stranger, seriesId)).toBeUndefined()

    const declined = await call(fx.app, {
      method: 'POST',
      url: `/events/${seriesId}/respond`,
      as: fx.users.viewer,
      payload: { status: 'declined', comment: 'В командировке' },
    })
    expect(declined.statusCode, declined.body).toBe(200)
    expect(declined.json().myStatus).toBe('declined')

    await drainOutbox()
    const titles = await notificationTitles(fx.users.member)
    expect(titles.some((title) => title.includes('примет участие'))).toBe(true)
    expect(titles.some((title) => title.includes('отказался'))).toBe(true)

    const record = await call(fx.app, { url: `/events/${seriesId}`, as: fx.users.member })
    const statuses = Object.fromEntries(
      (
        record.json().attendees as Array<{ user: { id: string }; status: string; role: string }>
      ).map((item) => [item.user.id, `${item.role}:${item.status}`]),
    )
    expect(statuses).toEqual({
      [fx.users.member.id]: 'organizer:accepted',
      [fx.users.stranger.id]: 'attendee:accepted',
      [fx.users.viewer.id]: 'attendee:declined',
    })
  })

  it('посторонний участник не правит встречу, организатор — да; ответить организатор не может', async () => {
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${seriesId}`,
      as: fx.users.stranger,
      payload: { title: 'взлом' },
    })
    expect(patch.statusCode).toBe(403)
    const respond = await call(fx.app, {
      method: 'POST',
      url: `/events/${seriesId}/respond`,
      as: fx.users.member,
      payload: { status: 'accepted' },
    })
    expect(respond.statusCode).toBe(403)
  })

  it('переговорная занята — второе бронирование на то же время отклоняется', async () => {
    const clash = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.stranger,
      payload: {
        title: `Совещание ${run}`,
        startsAt: at(addDays(monday, 7), '10:15'),
        endsAt: at(addDays(monday, 7), '11:00'),
        resourceIds: [roomId],
      },
    })
    expect(clash.statusCode, clash.body).toBe(409)
    expect(clash.json().data.conflicts[0].resourceId).toBe(roomId)
  })
})

describe('правка серии', () => {
  it('«только это»: перенос одного экземпляра', async () => {
    const third = at(addDays(monday, 14), '10:00')
    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${seriesId}`,
      as: fx.users.member,
      payload: {
        scope: 'occurrence',
        recurrenceId: third,
        startsAt: at(addDays(monday, 14), '11:00'),
        endsAt: at(addDays(monday, 14), '11:30'),
        title: `Планёрка (перенос) ${run}`,
      },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    const view = await range(
      fx.users.member,
      at(addDays(monday, 14), '00:00'),
      at(addDays(monday, 15), '00:00'),
    )
    const item = view.items.find((entry) => entry.eventId === seriesId)
    expect(item?.startsAt).toBe(at(addDays(monday, 14), '11:00'))
    expect(item?.recurrenceId).toBe(third)
    expect(item?.title).toBe(`Планёрка (перенос) ${run}`)
    expect(await instanceCount(seriesId)).toBe(10)

    await drainOutbox()
    const titles = await notificationTitles(fx.users.stranger)
    expect(titles.some((title) => title.includes('перенёс'))).toBe(true)
  })

  it('отмена одного экземпляра — исключение серии', async () => {
    const second = at(addDays(monday, 7), '10:00')
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/events/${seriesId}/cancel`,
      as: fx.users.member,
      payload: { scope: 'occurrence', recurrenceId: second },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(await instanceCount(seriesId)).toBe(9)
    const record = await call(fx.app, { url: `/events/${seriesId}`, as: fx.users.member })
    expect(record.json().exdates).toEqual([second])
  })

  it('«это и следующие»: серия делится, продолжение — новое событие с участниками', async () => {
    const fifth = at(addDays(monday, 28), '10:00')
    const split = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${seriesId}`,
      as: fx.users.member,
      payload: {
        scope: 'following',
        recurrenceId: fifth,
        startsAt: at(addDays(monday, 28), '14:00'),
        endsAt: at(addDays(monday, 28), '14:30'),
      },
    })
    expect(split.statusCode, split.body).toBe(200)
    const tailId = split.json().id as string
    expect(tailId).not.toBe(seriesId)
    // Голова: 4 исходных минус отменённый второй; продолжение — оставшиеся 6
    expect(await instanceCount(seriesId)).toBe(3)
    expect(await instanceCount(tailId)).toBe(6)

    const tail = await call(fx.app, { url: `/events/${tailId}`, as: fx.users.member })
    expect(tail.json().rrule).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=6')
    expect(tail.json().seriesId).toBe(seriesId)
    // Время изменилось — ответы сброшены, приглашение пришло заново
    const stranger = (
      tail.json().attendees as Array<{ user: { id: string }; status: string }>
    ).find((item) => item.user.id === fx.users.stranger.id)
    expect(stranger?.status).toBe('needs_action')
    expect(await inviteOf(fx.users.stranger, tailId)).toBeDefined()

    const view = await range(
      fx.users.member,
      at(addDays(monday, 28), '00:00'),
      at(addDays(monday, 29), '00:00'),
    )
    expect(view.items.filter((item) => item.eventId === seriesId)).toHaveLength(0)
    expect(view.items.find((item) => item.eventId === tailId)?.startsAt).toBe(
      at(addDays(monday, 28), '14:00'),
    )
  })

  it('«вся серия»: название меняется у всех экземпляров', async () => {
    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/events/${seriesId}`,
      as: fx.users.member,
      payload: { scope: 'series', title: `Штаб ${run}` },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    const view = await range(fx.users.member, at(monday, '00:00'), at(addDays(monday, 8), '00:00'))
    expect(view.items.find((item) => item.eventId === seriesId)?.title).toBe(`Штаб ${run}`)
  })
})

describe('видимость: «личное» и «занято»', () => {
  let privateId = ''
  let publicId = ''
  let memberCalendar = ''

  beforeAll(async () => {
    memberCalendar = (await personalCalendar(fx.users.member)).id
    const day = addDays(monday, 1)
    const secret = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: {
        title: `Врач ${run}`,
        startsAt: at(day, '15:00'),
        endsAt: at(day, '16:00'),
        visibility: 'private',
      },
    })
    expect(secret.statusCode, secret.body).toBe(200)
    privateId = secret.json().id
    const open = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: { title: `Обход ${run}`, startsAt: at(day, '09:00'), endsAt: at(day, '09:30') },
    })
    publicId = open.json().id
    // Участник делится личным календарём с читателем
    const shared = await call(fx.app, {
      method: 'POST',
      url: `/objects/${memberCalendar}/access`,
      as: fx.users.member,
      payload: { grants: [{ principal: { type: 'user', id: fx.users.viewer.id }, level: 'view' }] },
    })
    expect(shared.statusCode, shared.body).toBe(200)
    await redis().del(`kchs:principals:${fx.users.viewer.id}`)
  })

  it('чужое личное в календаре — «занято» без названия и идентификатора', async () => {
    const day = addDays(monday, 1)
    const view = await range(
      fx.users.viewer,
      at(day, '00:00'),
      at(addDays(day, 1), '00:00'),
      `&calendarIds=${memberCalendar}`,
    )
    const busy = view.items.find((item) => item.startsAt === at(day, '15:00'))
    expect(busy?.busy).toBe(true)
    expect(busy?.title).toBeNull()
    expect(busy?.eventId).toBeNull()
    expect(view.items.find((item) => item.eventId === publicId)?.title).toBe(`Обход ${run}`)
    expect(JSON.stringify(view)).not.toContain(`Врач ${run}`)

    // Прямой запрос — 404, администратор видит только «занято»
    expect(
      (await call(fx.app, { url: `/events/${privateId}`, as: fx.users.viewer })).statusCode,
    ).toBe(404)
    const admin = await call(fx.app, { url: `/events/${privateId}`, as: fx.admin })
    expect(admin.statusCode).toBe(200)
    expect(admin.json().busy).toBe(true)
    expect(admin.json().title).toBe('')
    const adminRange = await range(
      fx.admin,
      at(day, '00:00'),
      at(addDays(day, 1), '00:00'),
      `&calendarIds=${memberCalendar}`,
    )
    expect(JSON.stringify(adminRange)).not.toContain(`Врач ${run}`)
  })

  it('поиск не находит чужое личное, владелец находит', async () => {
    await indexObject(privateId)
    const search = async (user: TestUser) =>
      (
        (
          await call(fx.app, { url: `/search?q=${encodeURIComponent(`Врач ${run}`)}`, as: user })
        ).json().hits as Array<{ objectId: string }>
      ).map((hit) => hit.objectId)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !(await search(fx.users.member)).includes(privateId)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(await search(fx.users.member)).toContain(privateId)
    expect(await search(fx.users.viewer)).not.toContain(privateId)
  })

  it('занятость для подбора времени — интервал без названия', async () => {
    const day = addDays(monday, 1)
    const response = await call(fx.app, {
      url: `/calendar/free-busy?from=${encodeURIComponent(at(day, '00:00'))}&to=${encodeURIComponent(
        at(addDays(day, 1), '00:00'),
      )}&userIds=${fx.users.member.id}`,
      as: fx.users.stranger,
    })
    expect(response.statusCode, response.body).toBe(200)
    const busy = response.json().people[0].busy as Array<{ startsAt: string; title: string | null }>
    expect(busy.find((item) => item.startsAt === at(day, '15:00'))?.title).toBeNull()
    expect(JSON.stringify(response.json())).not.toContain(`Врач ${run}`)
  })

  it('ICS-подписка читателя отдаёт чужое личное как «Занято»', async () => {
    const feed = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${memberCalendar}/feeds`,
      as: fx.users.viewer,
    })
    expect(feed.statusCode, feed.body).toBe(200)
    const path = new URL(feed.json().url as string).pathname
    const ics = await call(fx.app, { url: path })
    expect(ics.statusCode, ics.body).toBe(200)
    expect(String(ics.headers['content-type'])).toContain('text/calendar')
    expect(ics.body).toContain(`SUMMARY:Обход ${run}`)
    expect(ics.body).toContain('SUMMARY:Занято')
    expect(ics.body).not.toContain(`Врач ${run}`)
  })
})

describe('напоминания', () => {
  it('срабатывают один раз, отказавшемуся — нет', async () => {
    const soon = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: {
        title: `Созвон ${run}`,
        startsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 35 * 60_000).toISOString(),
        attendees: [{ userId: fx.users.stranger.id }, { userId: fx.users.viewer.id }],
        reminders: [{ minutes: 10, channels: ['app', 'email'] }],
      },
    })
    expect(soon.statusCode, soon.body).toBe(200)
    const eventId = soon.json().id
    await call(fx.app, {
      method: 'POST',
      url: `/events/${eventId}/respond`,
      as: fx.users.viewer,
      payload: { status: 'declined' },
    })
    await planReminders(db(), [eventId])
    const recipients = async () =>
      (
        await db().execute<{ user_id: string }>(
          sql`SELECT user_id FROM event_reminders WHERE event_id = ${eventId} ORDER BY user_id`,
        )
      ).map((row) => row.user_id)
    expect((await recipients()).sort()).toEqual([fx.users.member.id, fx.users.stranger.id].sort())

    expect(await dispatchDueReminders()).toBe(2)
    // Повторный проход (перезапуск worker) ничего не отправляет
    expect(await dispatchDueReminders()).toBe(0)
    const [published] = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ops.outbox
           WHERE type = 'event.reminder' AND event->'object'->>'id' = ${eventId}`,
    )
    expect(published?.count).toBe(2)

    await drainOutbox()
    const titles = await notificationTitles(fx.users.stranger)
    expect(titles.some((title) => title.startsWith(`Напоминание: «Созвон ${run}»`))).toBe(true)
    const viewer = await notificationTitles(fx.users.viewer)
    expect(viewer.some((title) => title.startsWith(`Напоминание: «Созвон ${run}»`))).toBe(false)
  })
})

describe('проекции и ICS', () => {
  it('срок поручения — проекция в календаре исполнителя', async () => {
    const due = new Date(`${addDays(monday, 2)}T18:59:59.999Z`).toISOString()
    const task = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Подготовить сводку ${run}`,
        assigneeId: fx.users.member.id,
        dueAt: due,
        spaceId: fx.spaceId,
      },
    })
    expect(task.statusCode, task.body).toBe(200)
    const view = await range(
      fx.users.member,
      at(monday, '00:00'),
      at(addDays(monday, 7), '00:00'),
      '&projections=tasks.due',
    )
    const projection = view.projections.find((item) => item.objectId === task.json().id)
    expect(projection?.provider).toBe('tasks.due')
    expect(projection?.date).toBe(addDays(monday, 2))
    const stranger = await range(
      fx.users.stranger,
      at(monday, '00:00'),
      at(addDays(monday, 7), '00:00'),
      '&projections=tasks.due',
    )
    expect(stranger.projections.map((item) => item.objectId)).not.toContain(task.json().id)
  })

  it('лента подписки отдаёт серию с правилом и отзывается', async () => {
    const calendarId = (await personalCalendar(fx.users.member)).id
    const feed = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/feeds`,
      as: fx.users.member,
    })
    const path = new URL(feed.json().url as string).pathname
    const ics = await call(fx.app, { url: path })
    expect(ics.statusCode).toBe(200)
    expect(ics.body).toContain('BEGIN:VCALENDAR')
    expect(ics.body).toContain(`SUMMARY:Штаб ${run}`)
    expect(ics.body).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=')
    expect(ics.body).toContain('BEGIN:VTIMEZONE')
    expect(ics.body).toContain(`SUMMARY:Врач ${run}`)

    const feeds = await call(fx.app, { url: `/calendars/${calendarId}/feeds`, as: fx.users.member })
    expect(feeds.json().items).toHaveLength(1)
    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/calendars/${calendarId}/feeds/${feed.json().id}`,
      as: fx.users.member,
    })
    expect(revoked.statusCode).toBe(200)
    expect((await call(fx.app, { url: path })).statusCode).toBe(404)
    expect((await call(fx.app, { url: '/calendar-feeds/неверный.ics' })).statusCode).toBe(404)
  })

  it('импорт .ics: новые события, повторная загрузка не дублирует', async () => {
    const calendarId = (await personalCalendar(fx.users.stranger)).id
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//RU',
      'BEGIN:VEVENT',
      `UID:import-1-${run}`,
      `SUMMARY:Учения ${run}`,
      `DTSTART;TZID=Asia/Dushanbe:${addDays(monday, 3).replaceAll('-', '')}T090000`,
      `DTEND;TZID=Asia/Dushanbe:${addDays(monday, 3).replaceAll('-', '')}T120000`,
      'END:VEVENT',
      'BEGIN:VEVENT',
      `UID:import-2-${run}`,
      `SUMMARY:День защиты ${run}`,
      `DTSTART;VALUE=DATE:${addDays(monday, 4).replaceAll('-', '')}`,
      'RRULE:FREQ=YEARLY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const first = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/import`,
      as: fx.users.stranger,
      payload: { ics },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ created: 2, updated: 0, skipped: 0 })
    const second = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/import`,
      as: fx.users.stranger,
      payload: { ics },
    })
    expect(second.json()).toMatchObject({ created: 0, skipped: 2 })
    const view = await range(
      fx.users.stranger,
      at(addDays(monday, 3), '00:00'),
      at(addDays(monday, 5), '00:00'),
    )
    expect(view.items.map((item) => item.title)).toEqual(
      expect.arrayContaining([`Учения ${run}`, `День защиты ${run}`]),
    )
    // Чужой календарь — не загрузить
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/calendars/${calendarId}/import`,
      as: fx.users.viewer,
      payload: { ics },
    })
    expect(foreign.statusCode).toBe(404)
  })
})

describe('подбор времени', () => {
  it('окна в рабочие часы вне встреч участника и праздника', async () => {
    // Вторник после понедельника — праздник: день пропускается
    const holiday = addDays(monday, 1)
    const set = await call(fx.app, {
      method: 'PUT',
      url: `/admin/business-calendar/${holiday}`,
      as: fx.admin,
      payload: { kind: 'holiday', note: { ru: 'Проверка календаря' } },
    })
    expect(set.statusCode, set.body).toBe(200)
    try {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/calendar/find-time',
        as: fx.users.member,
        payload: {
          userIds: [fx.users.stranger.id],
          durationMinutes: 60,
          from: at(monday, '00:00'),
          to: at(addDays(monday, 3), '00:00'),
          limit: 6,
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      const slots = (response.json().slots as Array<{ startsAt: string }>).map(
        (slot) => slot.startsAt,
      )
      // Понедельник 10:00–10:30 — планёрка (участник принял): 09:00 свободно, 10:00 — нет
      expect(slots[0]).toBe(at(monday, '09:00'))
      expect(slots).not.toContain(at(monday, '10:00'))
      expect(slots.some((slot) => slot.startsWith(holiday))).toBe(false)
      expect(response.json().freeBusy.nonWorkingDays).toContain(holiday)
    } finally {
      await call(fx.app, {
        method: 'DELETE',
        url: `/admin/business-calendar/${holiday}`,
        as: fx.admin,
      })
    }
  })
})

describe('отмена события', () => {
  it('серия в корзину: дела во Входящих сняты, из календаря пропала', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/events',
      as: fx.users.member,
      payload: {
        title: `Разбор ${run}`,
        startsAt: at(addDays(monday, 2), '16:00'),
        endsAt: at(addDays(monday, 2), '17:00'),
        attendees: [{ userId: fx.users.stranger.id }],
      },
    })
    const eventId = created.json().id
    expect(await inviteOf(fx.users.stranger, eventId)).toBeDefined()
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/events/${eventId}/cancel`,
      as: fx.users.member,
      payload: { scope: 'series' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(await inviteOf(fx.users.stranger, eventId)).toBeUndefined()
    const view = await range(
      fx.users.stranger,
      at(addDays(monday, 2), '00:00'),
      at(addDays(monday, 3), '00:00'),
    )
    expect(view.items.map((item) => item.eventId)).not.toContain(eventId)
    await drainOutbox()
    expect(
      (await notificationTitles(fx.users.stranger)).some((title) => title.includes('отменил')),
    ).toBe(true)
  })
})

describe('подписка на внешний календарь', () => {
  it('канал читается, изменения и удаления переносятся, внутренние адреса закрыты', async () => {
    const { createServer } = await import('node:http')
    const { IcsService } = await import('../src/modules/calendar/domain/ics-service.js')
    const day = addDays(monday, 5).replaceAll('-', '')
    let body = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//feed//RU',
      'BEGIN:VEVENT',
      `UID:feed-1-${run}`,
      `SUMMARY:Праздник ${run}`,
      `DTSTART;VALUE=DATE:${day}`,
      'END:VEVENT',
      'BEGIN:VEVENT',
      `UID:feed-2-${run}`,
      `SUMMARY:Семинар ${run}`,
      `DTSTART:${day}T040000Z`,
      `DTEND:${day}T050000Z`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/calendar' })
      response.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const created = await call(fx.app, {
        method: 'POST',
        url: '/calendars',
        as: fx.users.stranger,
        payload: { kind: 'subscription', url: `http://127.0.0.1:${port}/feed.ics`, title: 'Лента' },
      })
      expect(created.statusCode, created.body).toBe(200)
      const calendarId = created.json().id as string
      await IcsService.syncSubscription(calendarId)
      const titles = async () => {
        const view = await range(
          fx.users.stranger,
          at(addDays(monday, 5), '00:00'),
          at(addDays(monday, 6), '00:00'),
          `&calendarIds=${calendarId}`,
        )
        return view.items.map((item) => item.title).sort()
      }
      expect(await titles()).toEqual([`Праздник ${run}`, `Семинар ${run}`].sort())
      const record = await call(fx.app, { url: `/calendars/${calendarId}`, as: fx.users.stranger })
      expect(record.json().subscription).toMatchObject({ status: 'ok', host: `127.0.0.1:${port}` })
      expect(record.json().can.edit).toBe(false)

      body = body
        .replace(`SUMMARY:Семинар ${run}`, `SUMMARY:Семинар перенесён ${run}`)
        .replace(/BEGIN:VEVENT\r\nUID:feed-1[\s\S]*?END:VEVENT\r\n/, '')
      await IcsService.syncSubscription(calendarId)
      expect(await titles()).toEqual([`Семинар перенесён ${run}`])

      // Событие подписки не правится в kchs
      const view = await range(
        fx.users.stranger,
        at(addDays(monday, 5), '00:00'),
        at(addDays(monday, 6), '00:00'),
        `&calendarIds=${calendarId}`,
      )
      const patch = await call(fx.app, {
        method: 'PATCH',
        url: `/events/${view.items[0]?.eventId}`,
        as: fx.users.stranger,
        payload: { title: 'правка' },
      })
      expect(patch.statusCode).toBe(403)
    } finally {
      server.close()
    }

    // Адреса внутренней сети и не-http закрыты
    const internal = await call(fx.app, {
      method: 'POST',
      url: '/calendars',
      as: fx.users.stranger,
      payload: { kind: 'subscription', url: 'file:///etc/passwd' },
    })
    expect(internal.statusCode).toBe(400)
    const { feedAddressDenied } = await import('../src/modules/calendar/domain/ics-fetch.js')
    expect(feedAddressDenied('169.254.169.254')).toBe(true)
    expect(feedAddressDenied('10.1.2.3')).toBe(true)
    expect(feedAddressDenied('::ffff:192.168.1.1')).toBe(true)
    expect(feedAddressDenied('8.8.8.8')).toBe(false)
  })
})
