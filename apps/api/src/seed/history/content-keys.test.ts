import { describe, expect, it } from 'vitest'
import { actKey, codeAllocator, incidentKey, keyed, minuteOf } from './content-keys.js'

describe('ключи истории по содержанию (ADR-0229)', () => {
  const base = {
    occurred_at: '2019-07-23T13:00:00+05:00',
    date_precision: 'day',
    territory: 'TJ-SU-08',
    type_raw: 'Сел',
    place: 'дж. Варзоб',
    deaths: 2,
  }

  it('строка выгрузки и строка базы дают один ключ; уточнение чисел ключ не меняет', () => {
    const stored = {
      ...base,
      occurred_at: new Date('2019-07-23T08:00:00.000Z'),
      type_raw: '  сел ',
      place: 'Дж. Варзоб.',
      deaths: 3,
    }
    expect(incidentKey(stored)).toBe(incidentKey(base))
    expect(minuteOf('2019-07-23T13:00:00+05:00')).toBe('2019-07-23T08:00')
  })

  it('другое место, район или время — другой ключ; без вида в источнике — код вида', () => {
    expect(incidentKey({ ...base, territory: 'TJ-SU-10' })).not.toBe(incidentKey(base))
    expect(incidentKey({ ...base, occurred_at: '2019-07-23T14:00:00+05:00' })).not.toBe(
      incidentKey(base),
    )
    expect(incidentKey({ ...base, type_raw: null, type_code: 'MUD' })).toContain('|mud|')
    expect(
      actKey({ origin: 'ЧС/2022.docx', place_raw: 'Ноҳияи Варзоб', event_date: '2022-05-30' }),
    ).toBe('чс/2022.docx|ноҳияи варзоб|2022-05-30|')
  })

  it('неразличимые строки сопоставляются по порядку в источнике', () => {
    const rows = [
      { ...base, code: 'H2019-0005', origin: 'Disaster 2019.xlsx, строка 12' },
      { ...base, code: 'H2019-0004', origin: 'Disaster 2019.xlsx, строка 9' },
    ]
    const byKey = keyed(rows, incidentKey)
    const key = incidentKey(base)
    expect(byKey.get(`${key}#0`)?.code).toBe('H2019-0004')
    expect(byKey.get(`${key}#1`)?.code).toBe('H2019-0005')
  })

  it('свободный код: свой, если не занят, иначе следующий номер года', () => {
    const next = codeAllocator(['H2019-0001', 'H2019-0002', 'H2022-D2022-012'])
    expect(next('H2019-0007')).toBe('H2019-0007')
    expect(next('H2019-0001')).toBe('H2019-0008')
    expect(next('H2020-0001')).toBe('H2020-0001')
    expect(next('H2020-0001')).toBe('H2020-0002')
    expect(next('H2022-D2022-012')).toBe('H2022-D2022-013')
  })
})
