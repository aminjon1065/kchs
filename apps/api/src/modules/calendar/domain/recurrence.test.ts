import { describe, expect, it } from 'vitest'
import {
  expandSeries,
  hasOccurrence,
  normalizeRule,
  RecurrenceError,
  type Series,
  shiftSeriesKeys,
  tailRule,
  truncateBefore,
} from './recurrence.js'
import { instantFromWall, localDate, startOfDate, wallMs } from './time.js'

const at = (value: string) => Date.parse(value)
const isoList = (values: number[]) => values.map((value) => new Date(value).toISOString())

function timed(
  startsAt: string,
  minutes: number,
  timezone: string,
  rrule: string | null,
  extra: Partial<Series> = {},
): Series {
  const start = at(startsAt)
  return {
    allDay: false,
    startsAt: start,
    endsAt: start + minutes * 60_000,
    startDate: null,
    endDate: null,
    timezone,
    rrule,
    exdates: [],
    overrides: {},
    ...extra,
  }
}

function allDay(
  startDate: string,
  endDate: string,
  timezone: string,
  rrule: string | null,
): Series {
  return {
    allDay: true,
    startsAt: startOfDate(startDate, timezone),
    endsAt: startOfDate(endDate, timezone),
    startDate,
    endDate,
    timezone,
    rrule,
    exdates: [],
    overrides: {},
  }
}

describe('время в поясах', () => {
  it('настенное время и обратно — Душанбе без летнего времени', () => {
    const instant = at('2026-09-21T05:00:00Z')
    expect(new Date(wallMs(instant, 'Asia/Dushanbe')).toISOString()).toBe(
      '2026-09-21T10:00:00.000Z',
    )
    expect(instantFromWall(at('2026-09-21T10:00:00Z'), 'Asia/Dushanbe')).toBe(instant)
    expect(localDate(at('2026-09-21T19:30:00Z'), 'Asia/Dushanbe')).toBe('2026-09-22')
  })

  it('весенний переход: несуществующее 02:30 сдвигается на 03:30', () => {
    // 8 марта 2026, Нью-Йорк: 02:00 → 03:00
    const instant = instantFromWall(at('2026-03-08T02:30:00Z'), 'America/New_York')
    expect(new Date(instant).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    expect(new Date(wallMs(instant, 'America/New_York')).toISOString()).toBe(
      '2026-03-08T03:30:00.000Z',
    )
  })

  it('осенний переход: неоднозначное 01:30 — раннее из двух', () => {
    // 1 ноября 2026, Нью-Йорк: 02:00 → 01:00, 01:30 бывает дважды
    const instant = instantFromWall(at('2026-11-01T01:30:00Z'), 'America/New_York')
    expect(new Date(instant).toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })
})

describe('развёртывание повторов', () => {
  it('еженедельно по понедельникам и средам, 4 раза — Душанбе', () => {
    const series = timed(
      '2026-09-21T05:00:00Z',
      60,
      'Asia/Dushanbe',
      'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
    )
    const { occurrences, complete } = expandSeries(series, at('2028-01-01T00:00:00Z'))
    expect(isoList(occurrences.map((o) => o.startsAt))).toEqual([
      '2026-09-21T05:00:00.000Z',
      '2026-09-23T05:00:00.000Z',
      '2026-09-28T05:00:00.000Z',
      '2026-09-30T05:00:00.000Z',
    ])
    expect(occurrences.every((o) => o.endsAt - o.startsAt === 3_600_000)).toBe(true)
    expect(complete).toBe(true)
  })

  it('летнее время: ежедневная встреча в 10:00 остаётся в 10:00 по местным часам', () => {
    const series = timed('2026-03-06T15:00:00Z', 30, 'America/New_York', 'FREQ=DAILY;COUNT=4')
    const { occurrences } = expandSeries(series, at('2026-12-31T00:00:00Z'))
    expect(isoList(occurrences.map((o) => o.startsAt))).toEqual([
      '2026-03-06T15:00:00.000Z',
      '2026-03-07T15:00:00.000Z',
      // Переход на летнее время 8 марта: 10:00 EDT = 14:00 UTC
      '2026-03-08T14:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
    ])
    for (const occurrence of occurrences) {
      expect(new Date(wallMs(occurrence.startsAt, 'America/New_York')).getUTCHours()).toBe(10)
    }
  })

  it('осенний переход в Европе: еженедельно в 09:00 по Берлину', () => {
    const series = timed('2026-10-19T07:00:00Z', 60, 'Europe/Berlin', 'FREQ=WEEKLY;COUNT=3')
    const { occurrences } = expandSeries(series, at('2026-12-31T00:00:00Z'))
    expect(isoList(occurrences.map((o) => o.startsAt))).toEqual([
      '2026-10-19T07:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
    ])
  })

  it('бесконечная серия — до горизонта и не «завершена»', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=DAILY')
    const { occurrences, complete } = expandSeries(series, at('2026-09-30T23:00:00Z'))
    expect(occurrences).toHaveLength(10)
    expect(complete).toBe(false)
  })

  it('предел числа экземпляров обрезает серию', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=DAILY')
    const { occurrences, complete } = expandSeries(series, at('2030-01-01T00:00:00Z'), 5)
    expect(occurrences).toHaveLength(5)
    expect(complete).toBe(false)
  })

  it('исключения и правка экземпляра', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=DAILY;COUNT=4', {
      exdates: ['2026-09-22T05:00:00.000Z'],
      overrides: {
        '2026-09-23T05:00:00.000Z': {
          startsAt: '2026-09-23T09:00:00.000Z',
          endsAt: '2026-09-23T09:30:00.000Z',
        },
      },
    })
    const { occurrences } = expandSeries(series, at('2027-01-01T00:00:00Z'))
    expect(
      occurrences.map((o) => [
        new Date(o.recurrenceId).toISOString(),
        new Date(o.startsAt).toISOString(),
        o.overridden,
      ]),
    ).toEqual([
      ['2026-09-21T05:00:00.000Z', '2026-09-21T05:00:00.000Z', false],
      ['2026-09-23T05:00:00.000Z', '2026-09-23T09:00:00.000Z', true],
      ['2026-09-24T05:00:00.000Z', '2026-09-24T05:00:00.000Z', false],
    ])
  })

  it('второй вторник месяца и последняя пятница', () => {
    const second = timed(
      '2026-10-13T06:00:00Z',
      60,
      'Asia/Dushanbe',
      'FREQ=MONTHLY;BYDAY=2TU;COUNT=3',
    )
    expect(
      expandSeries(second, at('2027-06-01T00:00:00Z')).occurrences.map((o) =>
        localDate(o.startsAt, 'Asia/Dushanbe'),
      ),
    ).toEqual(['2026-10-13', '2026-11-10', '2026-12-08'])
    const last = timed(
      '2026-10-30T11:00:00Z',
      60,
      'Asia/Dushanbe',
      'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3',
    )
    expect(
      expandSeries(last, at('2027-06-01T00:00:00Z')).occurrences.map((o) =>
        localDate(o.startsAt, 'Asia/Dushanbe'),
      ),
    ).toEqual(['2026-10-30', '2026-11-27', '2026-12-25'])
  })

  it('начало вне шаблона — всё равно первый экземпляр', () => {
    // Вторник, правило — по понедельникам
    const series = timed(
      '2026-09-22T05:00:00Z',
      60,
      'Asia/Dushanbe',
      'FREQ=WEEKLY;BYDAY=MO;COUNT=2',
    )
    const dates = expandSeries(series, at('2027-01-01T00:00:00Z')).occurrences.map((o) =>
      localDate(o.startsAt, 'Asia/Dushanbe'),
    )
    expect(dates).toEqual(['2026-09-22', '2026-09-28', '2026-10-05'])
  })

  it('событие на весь день: ежегодно, два дня, в поясе события', () => {
    const series = allDay('2026-03-21', '2026-03-23', 'Asia/Dushanbe', 'FREQ=YEARLY;COUNT=3')
    const { occurrences } = expandSeries(series, at('2030-01-01T00:00:00Z'))
    expect(occurrences.map((o) => [o.startDate, o.endDate])).toEqual([
      ['2026-03-21', '2026-03-23'],
      ['2027-03-21', '2027-03-23'],
      ['2028-03-21', '2028-03-23'],
    ])
    expect(new Date(occurrences[1]?.startsAt ?? 0).toISOString()).toBe('2027-03-20T19:00:00.000Z')
  })

  it('UNTIL: момент включается, дата у события на весь день — тоже', () => {
    const series = timed(
      '2026-09-21T05:00:00Z',
      60,
      'Asia/Dushanbe',
      'FREQ=DAILY;UNTIL=20260923T050000Z',
    )
    expect(expandSeries(series, at('2027-01-01T00:00:00Z')).occurrences).toHaveLength(3)
    const days = allDay('2026-09-21', '2026-09-22', 'Asia/Dushanbe', 'FREQ=DAILY;UNTIL=20260923')
    expect(
      expandSeries(days, at('2027-01-01T00:00:00Z')).occurrences.map((o) => o.startDate),
    ).toEqual(['2026-09-21', '2026-09-22', '2026-09-23'])
  })

  it('экземпляр серии узнаётся по исходному началу', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=WEEKLY;BYDAY=MO')
    expect(hasOccurrence(series, at('2026-10-05T05:00:00Z'))).toBe(true)
    expect(hasOccurrence(series, at('2026-10-06T05:00:00Z'))).toBe(false)
    expect(hasOccurrence(series, at('2026-10-05T06:00:00Z'))).toBe(false)
  })
})

describe('нормализация правила', () => {
  const time = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', null)

  it('принимает RRULE: и приводит UNTIL к моменту UTC конца дня', () => {
    expect(normalizeRule('RRULE:freq=weekly;byday=MO;until=20261231', time)).toBe(
      'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T185959Z',
    )
  })

  it('у события на весь день UNTIL — дата', () => {
    const days = allDay('2026-09-21', '2026-09-22', 'Asia/Dushanbe', null)
    expect(normalizeRule('FREQ=DAILY;UNTIL=20261231T185959Z', days)).toBe(
      'FREQ=DAILY;UNTIL=20261231',
    )
  })

  it('отклоняет частые повторы, COUNT вместе с UNTIL и мусор', () => {
    expect(() => normalizeRule('FREQ=HOURLY', time)).toThrow(RecurrenceError)
    expect(() => normalizeRule('FREQ=DAILY;COUNT=3;UNTIL=20261231', time)).toThrow(RecurrenceError)
    expect(() => normalizeRule('FREQ=DAILY;BYHOUR=10', time)).toThrow(RecurrenceError)
    expect(() => normalizeRule('FREQ=DAILY;COUNT=0', time)).toThrow(RecurrenceError)
    expect(() => normalizeRule('это не правило', time)).toThrow(RecurrenceError)
  })
})

describe('«это и следующие»', () => {
  it('голова серии обрывается перед экземпляром, хвост получает остаток COUNT', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=DAILY;COUNT=10')
    const split = at('2026-09-24T05:00:00Z')
    const head = truncateBefore(series, split)
    expect(head).toBe('FREQ=DAILY;UNTIL=20260924T045959Z')
    const headOccurrences = expandSeries({ ...series, rrule: head }, at('2027-01-01T00:00:00Z'))
    expect(headOccurrences.occurrences).toHaveLength(3)
    expect(headOccurrences.complete).toBe(true)

    expect(tailRule(series, split)).toBe('FREQ=DAILY;COUNT=7')
    expect(truncateBefore(series, at('2026-09-21T05:00:00Z'))).toBeNull()
  })

  it('событие на весь день обрывается предыдущим днём', () => {
    const series = allDay('2026-09-21', '2026-09-22', 'Asia/Dushanbe', 'FREQ=WEEKLY')
    expect(truncateBefore(series, startOfDate('2026-10-05', 'Asia/Dushanbe'))).toBe(
      'FREQ=WEEKLY;UNTIL=20261004',
    )
  })

  it('исключения и правки переезжают вслед за началом серии', () => {
    const series = timed('2026-09-21T05:00:00Z', 60, 'Asia/Dushanbe', 'FREQ=DAILY', {
      exdates: ['2026-09-23T05:00:00.000Z'],
      overrides: { '2026-09-24T05:00:00.000Z': { title: 'Перенесено' } },
    })
    const next = {
      ...series,
      startsAt: at('2026-09-21T06:00:00Z'),
      endsAt: at('2026-09-21T07:00:00Z'),
    }
    expect(shiftSeriesKeys(series, next)).toEqual({
      exdates: ['2026-09-23T06:00:00.000Z'],
      overrides: { '2026-09-24T06:00:00.000Z': { title: 'Перенесено' } },
    })
  })
})
