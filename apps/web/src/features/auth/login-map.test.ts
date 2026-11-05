import { describe, expect, it } from 'vitest'
import { LOGIN_MAP } from './login-map-data.js'
import { capitalCoordinates } from './login-map.js'

describe('карта экрана входа', () => {
  it('города лежат внутри карты, столица одна, названия на трёх языках', () => {
    expect(LOGIN_MAP.cities.filter((city) => city.capital)).toHaveLength(1)
    for (const city of LOGIN_MAP.cities) {
      expect(city.x).toBeGreaterThan(0)
      expect(city.x).toBeLessThan(LOGIN_MAP.width)
      expect(city.y).toBeGreaterThan(0)
      expect(city.y).toBeLessThan(LOGIN_MAP.height)
      expect(Object.keys(city.name).sort()).toEqual(['en', 'ru', 'tg'])
    }
    expect(LOGIN_MAP.districts.startsWith('M')).toBe(true)
  })

  it('координаты столицы — с двумя знаками и десятичным разделителем языка', () => {
    expect(capitalCoordinates('ru')).toEqual({ lat: '38,56', lon: '68,78' })
    expect(capitalCoordinates('en')).toEqual({ lat: '38.56', lon: '68.78' })
  })
})
