import { describe, expect, it } from 'vitest'
import {
  buildCalendar,
  escapeText,
  foldLine,
  type IcsEvent,
  parseCalendar,
  vtimezone,
} from './ics.js'

const at = (value: string) => Date.parse(value)

function event(extra: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: 'e1@kchs',
    sequence: 2,
    stamp: at('2026-09-19T10:00:00Z'),
    summary: 'Планёрка; штаб, этаж 2',
    description: 'Строка 1\nСтрока 2',
    location: 'Зал 305',
    allDay: false,
    startsAt: at('2026-09-21T05:00:00Z'),
    endsAt: at('2026-09-21T05:30:00Z'),
    startDate: null,
    endDate: null,
    timezone: 'Asia/Dushanbe',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=5',
    exdates: ['2026-09-28T05:00:00.000Z'],
    changes: [
      {
        recurrenceId: at('2026-10-05T05:00:00Z'),
        startsAt: at('2026-10-05T07:00:00Z'),
        endsAt: at('2026-10-05T07:30:00Z'),
        startDate: null,
        endDate: null,
        summary: 'Планёрка (перенос)',
      },
    ],
    transparent: false,
    private: false,
    url: 'https://kchs.local/o/e1',
    ...extra,
  }
}

describe('текст iCalendar', () => {
  it('экранирует спецсимволы и переводы строк', () => {
    expect(escapeText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne')
  })

  it('сворачивает строку по 75 байт UTF-8, не разрывая символы', () => {
    const line = `SUMMARY:${'ж'.repeat(80)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    expect(parts.map((part, index) => (index === 0 ? part : part.slice(1))).join('')).toBe(line)
  })

  it('VTIMEZONE: без летнего времени — одно смещение, с ним — переходы', () => {
    expect(vtimezone('Asia/Dushanbe', 2026, 2026)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Dushanbe',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0500',
      'TZOFFSETTO:+0500',
      'END:STANDARD',
      'END:VTIMEZONE',
    ])
    const berlin = vtimezone('Europe/Berlin', 2026, 2026).join('\n')
    expect(berlin).toContain(
      'BEGIN:DAYLIGHT\nDTSTART:20260329T020000\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200',
    )
    expect(berlin).toContain(
      'BEGIN:STANDARD\nDTSTART:20261025T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100',
    )
  })
})

describe('лента и разбор', () => {
  it('повторяющееся событие проходит круг «лента → разбор» без потерь', () => {
    const text = buildCalendar('Мой календарь', [event()], { busyLabel: 'Занято' })
    expect(text).toContain('DTSTART;TZID=Asia/Dushanbe:20260921T100000')
    expect(text).toContain('EXDATE;TZID=Asia/Dushanbe:20260928T100000')
    expect(text).toContain('RECURRENCE-ID;TZID=Asia/Dushanbe:20261005T100000')
    expect(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75)).toBe(
      true,
    )

    const { events, errors } = parseCalendar(text, 'UTC')
    expect(errors).toEqual([])
    expect(events).toHaveLength(1)
    const parsed = events[0]
    expect(parsed?.summary).toBe('Планёрка; штаб, этаж 2')
    expect(parsed?.description).toBe('Строка 1\nСтрока 2')
    expect(parsed?.timezone).toBe('Asia/Dushanbe')
    expect(parsed?.startsAt).toBe(at('2026-09-21T05:00:00Z'))
    expect(parsed?.endsAt).toBe(at('2026-09-21T05:30:00Z'))
    expect(parsed?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO;COUNT=5')
    expect(parsed?.exdates).toEqual(['2026-09-28T05:00:00.000Z'])
    expect(parsed?.overrides).toEqual({
      '2026-10-05T05:00:00.000Z': {
        startsAt: '2026-10-05T07:00:00.000Z',
        endsAt: '2026-10-05T07:30:00.000Z',
        title: 'Планёрка (перенос)',
        location: 'Зал 305',
        description: 'Строка 1\nСтрока 2',
      },
    })
  })

  it('скрытое событие отдаётся как «занято» без деталей', () => {
    const text = buildCalendar('Календарь', [event({ private: true, changes: [] })], {
      busyLabel: 'Занято',
    })
    expect(text).toContain('SUMMARY:Занято')
    expect(text).toContain('CLASS:PRIVATE')
    expect(text).not.toContain('Планёрка')
    expect(text).not.toContain('LOCATION')
    expect(text).not.toContain('DESCRIPTION')
  })

  it('событие на весь день и одиночное — датами и в UTC', () => {
    const text = buildCalendar(
      'Календарь',
      [
        event({
          uid: 'd1',
          allDay: true,
          startDate: '2026-03-21',
          endDate: '2026-03-23',
          rrule: null,
          exdates: [],
          changes: [],
        }),
        event({ uid: 's1', rrule: null, exdates: [], changes: [] }),
      ],
      { busyLabel: 'Занято' },
    )
    expect(text).toContain('DTSTART;VALUE=DATE:20260321')
    expect(text).toContain('DTEND;VALUE=DATE:20260323')
    expect(text).toContain('DTSTART:20260921T050000Z')
    const { events } = parseCalendar(text, 'Asia/Dushanbe')
    const day = events.find((item) => item.uid === 'd1')
    expect(day?.allDay).toBe(true)
    expect([day?.startDate, day?.endDate]).toEqual(['2026-03-21', '2026-03-23'])
  })

  it('импорт: пояс Windows из VTIMEZONE, отменённый экземпляр, «плавающее» время', () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Microsoft Corporation//Outlook 16.0//EN',
      'BEGIN:VTIMEZONE',
      'TZID:West Asia Standard Time',
      'BEGIN:STANDARD',
      'DTSTART:16010101T000000',
      'TZOFFSETFROM:+0500',
      'TZOFFSETTO:+0500',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:outlook-1',
      'SUMMARY:Совещание',
      'DTSTART;TZID=West Asia Standard Time:20260922T090000',
      'DTEND;TZID=West Asia Standard Time:20260922T100000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'CLASS:PRIVATE',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:outlook-1',
      'RECURRENCE-ID;TZID=West Asia Standard Time:20260923T090000',
      'STATUS:CANCELLED',
      'DTSTART;TZID=West Asia Standard Time:20260923T090000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:floating-1',
      'SUMMARY:Обед',
      'DTSTART:20260922T130000',
      'DTEND:20260922T140000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const { events, errors } = parseCalendar(text, 'Asia/Dushanbe')
    expect(errors).toEqual([])
    const outlook = events.find((item) => item.uid === 'outlook-1')
    expect(outlook?.startsAt).toBe(at('2026-09-22T04:00:00Z'))
    expect(outlook?.private).toBe(true)
    expect(outlook?.exdates).toEqual(['2026-09-23T04:00:00.000Z'])
    const floating = events.find((item) => item.uid === 'floating-1')
    expect(floating?.startsAt).toBe(at('2026-09-22T08:00:00Z'))
    expect(floating?.timezone).toBe('Asia/Dushanbe')
  })

  it('не календарь — понятная ошибка', () => {
    expect(parseCalendar('<html>не то</html>', 'UTC').errors[0]?.message).toMatch(/iCalendar/)
  })
})
