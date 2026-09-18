import { describe, expect, it } from 'vitest'
import { dayRange, relativeRange } from '../ranges.js'

const NOW = new Date('2026-09-18T10:00:00Z') // пятница, 15:00 в Душанбе
const TZ = 'Asia/Dushanbe'

const iso = (range: { from: Date; to: Date }) => [range.from.toISOString(), range.to.toISOString()]

describe('relativeRange', () => {
  it('сегодня — сутки по местному времени', () => {
    expect(iso(relativeRange({ unit: 'day', from: 0, to: 0 }, NOW, TZ))).toEqual([
      '2026-09-17T19:00:00.000Z',
      '2026-09-18T19:00:00.000Z',
    ])
  })

  it('последние 12 месяцев включая текущий', () => {
    expect(iso(relativeRange({ unit: 'month', from: -11, to: 0 }, NOW, TZ))).toEqual([
      '2025-09-30T19:00:00.000Z',
      '2026-09-30T19:00:00.000Z',
    ])
  })

  it('неделя начинается с понедельника', () => {
    expect(iso(relativeRange({ unit: 'week', from: 0, to: 0 }, NOW, TZ))).toEqual([
      '2026-09-13T19:00:00.000Z',
      '2026-09-20T19:00:00.000Z',
    ])
  })

  it('прошлый квартал и текущий год', () => {
    expect(iso(relativeRange({ unit: 'quarter', from: -1, to: -1 }, NOW, TZ))).toEqual([
      '2026-03-31T19:00:00.000Z',
      '2026-06-30T19:00:00.000Z',
    ])
    expect(iso(relativeRange({ unit: 'year', from: 0, to: 0 }, NOW, TZ))).toEqual([
      '2025-12-31T19:00:00.000Z',
      '2026-12-31T19:00:00.000Z',
    ])
  })

  it('перепутанные границы нормализуются', () => {
    expect(relativeRange({ unit: 'day', from: 0, to: -6 }, NOW, TZ)).toEqual(
      relativeRange({ unit: 'day', from: -6, to: 0 }, NOW, TZ),
    )
  })
})

describe('dayRange', () => {
  it('день определяется в часовом поясе пользователя', () => {
    // 20:30 UTC — уже 19 сентября в Душанбе
    expect(iso(dayRange(new Date('2026-09-18T20:30:00Z'), TZ))).toEqual([
      '2026-09-18T19:00:00.000Z',
      '2026-09-19T19:00:00.000Z',
    ])
  })

  it('переход на летнее время: сутки короче на час', () => {
    const range = dayRange(new Date('2026-03-29T12:00:00Z'), 'Europe/Berlin')
    expect(iso(range)).toEqual(['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'])
  })
})
