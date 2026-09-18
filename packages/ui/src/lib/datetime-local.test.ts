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
})
