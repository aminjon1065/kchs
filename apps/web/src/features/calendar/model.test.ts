import type { CalendarRangeItem } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  daysFor,
  daysOfItem,
  placeAllDay,
  placeTimed,
  projectionsByDay,
  shiftAnchor,
  variantOf,
} from './model.js'
import {
  addDays,
  clockMinutes,
  clockText,
  instantAt,
  startOfWeek,
  todayIn,
  wallOf,
} from './time.js'

const TZ = 'Asia/Dushanbe'

function item(patch: Partial<CalendarRangeItem>): CalendarRangeItem {
  return {
    key: 'k',
    eventId: '00000000-0000-4000-8000-000000000001',
    calendarId: '00000000-0000-4000-8000-000000000002',
    recurrenceId: null,
    recurring: false,
    startsAt: '2026-09-21T05:00:00.000Z',
    endsAt: '2026-09-21T06:00:00.000Z',
    allDay: false,
    startDate: null,
    endDate: null,
    busy: false,
    title: 'Планёрка',
    location: null,
    color: 'blue',
    visibility: 'public',
    showAs: 'busy',
    myStatus: null,
    organizer: null,
    attendeeCount: 1,
    invitation: false,
    hasMeeting: false,
    canEdit: true,
    ...patch,
  }
}

describe('время календаря в поясе пользователя', () => {
  it('минуты суток и момент — туда и обратно', () => {
    const at = instantAt('2026-09-21', 10 * 60 + 30, TZ)
    expect(new Date(at).toISOString()).toBe('2026-09-21T05:30:00.000Z')
    expect(wallOf(at, TZ)).toEqual({ date: '2026-09-21', minute: 630 })
    expect(todayIn(TZ, Date.parse('2026-09-21T20:00:00Z'))).toBe('2026-09-22')
  })

  it('переход на летнее время: несуществующее 02:30 сдвигается вперёд, двойное 01:30 — раннее', () => {
    // Нью-Йорк: 8 марта 2026 02:00 → 03:00, 1 ноября 2026 02:00 → 01:00
    expect(new Date(instantAt('2026-03-08', 150, 'America/New_York')).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    )
    expect(new Date(instantAt('2026-11-01', 90, 'America/New_York')).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    // Сутки перехода: полночь следующего дня — через 23 часа
    const day =
      instantAt('2026-03-09', 0, 'America/New_York') -
      instantAt('2026-03-08', 0, 'America/New_York')
    expect(day / 3_600_000).toBe(23)
  })

  it('даты, неделя с понедельника, часы', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(startOfWeek('2026-09-27')).toBe('2026-09-21')
    expect(clockMinutes('09:45')).toBe(585)
    expect(clockText(24 * 60)).toBe('00:00')
  })
})

describe('раскладка событий по виду', () => {
  it('неделя, месяц из шести недель, повестка на месяц; переход назад и вперёд', () => {
    expect(daysFor('week', '2026-09-24')).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ])
    const month = daysFor('month', '2026-09-24')
    expect(month).toHaveLength(42)
    expect(month[0]).toBe('2026-08-31')
    expect(shiftAnchor('month', '2026-01-31', 1)).toBe('2026-02-01')
    expect(shiftAnchor('week', '2026-09-24', -1)).toBe('2026-09-17')
    expect(daysFor('agenda', '2026-09-24')).toHaveLength(30)
  })

  it('событие через полночь делится на куски по дням', () => {
    const night = item({
      startsAt: '2026-09-21T17:00:00.000Z', // 22:00 по Душанбе
      endsAt: '2026-09-21T21:00:00.000Z', // 02:00 следующего дня
    })
    const placed = placeTimed([night], daysFor('week', '2026-09-21'), TZ)
    expect(placed.map((piece) => [piece.day, piece.start, piece.end, piece.partial])).toEqual([
      [0, 22 * 60, 24 * 60, true],
      [1, 0, 2 * 60, true],
    ])
    // Конец ровно в полночь — последний день предыдущий
    const toMidnight = item({
      startsAt: '2026-09-21T17:00:00.000Z',
      endsAt: '2026-09-21T19:00:00.000Z',
    })
    expect(placeTimed([toMidnight], daysFor('week', '2026-09-21'), TZ)).toHaveLength(1)
    expect(daysOfItem(toMidnight, TZ)).toEqual(['2026-09-21'])
  })

  it('событие на несколько дней обрезается видом', () => {
    const trip = item({
      allDay: true,
      startDate: '2026-09-19',
      endDate: '2026-09-23',
    })
    expect(placeAllDay([trip], daysFor('week', '2026-09-21'))).toEqual([
      { key: 'k', item: trip, first: 0, last: 2 },
    ])
    expect(daysOfItem(trip, TZ)).toHaveLength(5)
  })

  it('вид события: занято, приглашение без ответа, «возможно», отказ, свободно', () => {
    expect(variantOf(item({ busy: true }))).toBe('busy')
    expect(variantOf(item({ invitation: true, myStatus: 'needs_action' }))).toBe('pending')
    expect(variantOf(item({ myStatus: 'tentative' }))).toBe('tentative')
    expect(variantOf(item({ myStatus: 'declined' }))).toBe('declined')
    expect(variantOf(item({ showAs: 'free' }))).toBe('free')
    expect(variantOf(item({}))).toBe('solid')
  })

  it('сроки других модулей группируются по дням', () => {
    const byDay = projectionsByDay([
      {
        key: 'a',
        provider: 'tasks.due',
        objectId: '00000000-0000-4000-8000-000000000003',
        objectType: 'task',
        title: 'Сводка',
        subtitle: null,
        date: '2026-09-22',
        at: null,
        status: 'open',
        overdue: false,
        done: false,
      },
    ])
    expect(byDay.get('2026-09-22')).toHaveLength(1)
  })
})
