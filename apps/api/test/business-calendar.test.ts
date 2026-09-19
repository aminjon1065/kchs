import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Производственный календарь для сроков (фаза 3: сроки шагов маршрутов и
 * поручений в рабочих днях): правка дней администратором, сдвиг на рабочие
 * дни с праздником, срок «до конца дня» в поясе установки.
 */
registerLifecycle()

const { BusinessCalendar } = await import('../src/kernel/business-calendar/service.js')

let fx: TestContext
/** Год, которого нет у других тестов: исключения прогона не мешают соседям. */
const YEAR = 2031

beforeAll(async () => {
  fx = await setupFixture()
  await db().execute(
    sql`DELETE FROM business_calendar WHERE day BETWEEN '2031-01-01' AND '2031-12-31'`,
  )
})

afterAll(async () => {
  await db().execute(
    sql`DELETE FROM business_calendar WHERE day BETWEEN '2031-01-01' AND '2031-12-31'`,
  )
})

describe('производственный календарь', () => {
  it('администратор задаёт праздник — срок в рабочих днях его пропускает', async () => {
    // Пятница 14 марта 2031 + 1 рабочий день — понедельник 17-е
    expect(await BusinessCalendar.addWorkingDays('2031-03-14', 1)).toBe('2031-03-17')

    const set = await call(fx.app, {
      method: 'PUT',
      url: '/admin/business-calendar/2031-03-17',
      as: fx.admin,
      payload: { kind: 'holiday', note: { ru: 'Проверочный праздник' } },
    })
    expect(set.statusCode, set.body).toBe(200)
    expect(await BusinessCalendar.addWorkingDays('2031-03-14', 1)).toBe('2031-03-18')

    const year = await call(fx.app, { url: `/business-calendar?year=${YEAR}`, as: fx.users.member })
    expect(year.statusCode, year.body).toBe(200)
    expect(year.json().days).toEqual([
      { day: '2031-03-17', kind: 'holiday', note: { ru: 'Проверочный праздник' } },
    ])

    // Срок «1 рабочий день» от пятницы 14-го, 16:00 по Душанбе — конец вторника 18-го
    const deadline = await call(fx.app, {
      url: '/business-calendar/deadline?workingDays=1&from=2031-03-14T11:00:00Z',
      as: fx.users.member,
    })
    expect(deadline.json()).toEqual({ date: '2031-03-18', dueAt: '2031-03-18T18:59:59.999Z' })

    // Рабочая суббота считается рабочим днём
    await call(fx.app, {
      method: 'PUT',
      url: '/admin/business-calendar/2031-03-15',
      as: fx.admin,
      payload: { kind: 'work' },
    })
    expect(await BusinessCalendar.addWorkingDays('2031-03-14', 1)).toBe('2031-03-15')
    expect(await BusinessCalendar.workingDaysBetween('2031-03-14', '2031-03-19')).toBe(3)

    // Снять исключения — снова по правилу недели
    for (const day of ['2031-03-15', '2031-03-17']) {
      const cleared = await call(fx.app, {
        method: 'DELETE',
        url: `/admin/business-calendar/${day}`,
        as: fx.admin,
      })
      expect(cleared.json()).toEqual({ removed: true })
    }
    expect(await BusinessCalendar.addWorkingDays('2031-03-14', 1)).toBe('2031-03-17')
  })

  it('правка — событие и аудит; без права администратора — 403', async () => {
    const denied = await call(fx.app, {
      method: 'PUT',
      url: '/admin/business-calendar/2031-05-05',
      as: fx.users.member,
      payload: { kind: 'holiday' },
    })
    expect(denied.statusCode).toBe(403)

    await call(fx.app, {
      method: 'PUT',
      url: '/admin/business-calendar/2031-05-05',
      as: fx.admin,
      payload: { kind: 'weekend' },
    })
    const events = await db().execute<{ type: string; payload: Record<string, unknown> }>(
      sql`SELECT event->>'type' AS type, event->'payload' AS payload FROM ops.outbox
          WHERE event->>'type' = 'settings.business_calendar_changed' ORDER BY id DESC LIMIT 1`,
    )
    expect(events[0]?.payload).toEqual({ country: 'TJ', day: '2031-05-05', kind: 'weekend' })
    const trail = await call(fx.app, {
      url: '/admin/audit?action=business_calendar.changed',
      as: fx.admin,
    })
    expect(trail.json().items.length).toBeGreaterThan(0)
  })
})
