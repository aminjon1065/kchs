import { describe, expect, it } from 'vitest'
import { fromLocalInput, toLocalInput } from './datetime-local.js'

describe('datetime-local ↔ ISO', () => {
  it('показывает время в поясе браузера, а не UTC-часть строки', () => {
    const iso = '2026-09-12T06:15:00.000Z'
    const date = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    expect(toLocalInput(iso)).toBe(local)
  })

  it('правка без изменений не сдвигает время', () => {
    for (const iso of [
      '2026-09-12T06:15:00.000Z',
      '2026-03-29T23:45:00.000Z',
      '2026-12-31T19:00:00.000Z',
    ]) {
      expect(fromLocalInput(toLocalInput(iso))).toBe(iso)
    }
  })

  it('некорректное значение — пустое поле', () => {
    expect(toLocalInput('не дата')).toBe('')
  })

  it('в поясе профиля: Душанбе (UTC+5) независимо от пояса браузера', () => {
    expect(toLocalInput('2026-09-12T06:15:00.000Z', 'Asia/Dushanbe')).toBe('2026-09-12T11:15')
    expect(fromLocalInput('2026-09-12T11:15', 'Asia/Dushanbe')).toBe('2026-09-12T06:15:00.000Z')
    // Через полночь: 21:30 UTC — уже следующий день в Душанбе
    expect(toLocalInput('2026-12-31T21:30:00.000Z', 'Asia/Dushanbe')).toBe('2027-01-01T02:30')
  })

  it('в поясе с летним временем правка без изменений не сдвигает время', () => {
    for (const iso of ['2026-03-08T12:00:00.000Z', '2026-11-01T05:30:00.000Z']) {
      expect(fromLocalInput(toLocalInput(iso, 'America/New_York'), 'America/New_York')).toBe(iso)
    }
  })
})
