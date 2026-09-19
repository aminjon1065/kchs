import { describe, expect, it } from 'vitest'
import {
  formatDecimal,
  formatDms,
  formatHemispheres,
  parseCoordinates,
  roundScale,
  scaleDenominator,
} from './coordinates.js'

const first = (text: string) => parseCoordinates(text)[0]

describe('parseCoordinates', () => {
  it('десятичные градусы: «широта, долгота» и запасной вариант наоборот', () => {
    const candidates = parseCoordinates('38.56, 68.78')
    expect(candidates).toEqual([
      { lat: 38.56, lon: 68.78, order: 'latlon' },
      { lat: 68.78, lon: 38.56, order: 'lonlat' },
    ])
    expect(first('38.56 68.78')).toMatchObject({ lat: 38.56, lon: 68.78 })
    expect(first('38.56;68.78')).toMatchObject({ lat: 38.56, lon: 68.78 })
  })

  it('долгота за пределами широты задаёт порядок сама', () => {
    expect(parseCoordinates('130.8, -12.5')).toEqual([{ lat: -12.5, lon: 130.8, order: 'lonlat' }])
    expect(parseCoordinates('-12.5 130.8')).toEqual([{ lat: -12.5, lon: 130.8, order: 'latlon' }])
  })

  it('десятичная запятая: пара через пробел или точку с запятой', () => {
    expect(first('38,56 68,78')).toMatchObject({ lat: 38.56, lon: 68.78 })
    expect(first('38,5; 68,7')).toMatchObject({ lat: 38.5, lon: 68.7 })
    expect(first('38, 68')).toMatchObject({ lat: 38, lon: 68 })
  })

  it('полушария буквами и словами', () => {
    expect(parseCoordinates('38.56N 68.78E')).toEqual([
      { lat: 38.56, lon: 68.78, order: 'hemisphere' },
    ])
    expect(first('68.78 E, 38.56 N')).toMatchObject({ lat: 38.56, lon: 68.78 })
    expect(first('N38.56 E68.78')).toMatchObject({ lat: 38.56, lon: 68.78 })
    expect(first('38.56 с. ш. 68.78 в. д.')).toMatchObject({ lat: 38.56, lon: 68.78 })
    expect(first('33.9 ю.ш. 18.4 в.д.')).toMatchObject({ lat: -33.9, lon: 18.4 })
    expect(first('40.7N 74W')).toMatchObject({ lat: 40.7, lon: -74 })
  })

  it('градусы, минуты, секунды и десятичные минуты', () => {
    const dms = first(`38°33'36"N 68°46'48"E`)
    expect(dms?.lat).toBeCloseTo(38.56, 6)
    expect(dms?.lon).toBeCloseTo(68.78, 6)
    const unicode = first('38°33′36″ с.ш. 68°46′48″ в.д.')
    expect(unicode?.lat).toBeCloseTo(38.56, 6)
    const spaced = first('38 33 36 N 68 46 48 E')
    expect(spaced?.lon).toBeCloseTo(68.78, 6)
    const minutes = first(`38°33.6'N 68°46.8'E`)
    expect(minutes?.lat).toBeCloseTo(38.56, 6)
    expect(minutes?.lon).toBeCloseTo(68.78, 6)
    const noHemisphere = first(`38°33'36" 68°46'48"`)
    expect(noHemisphere?.lat).toBeCloseTo(38.56, 6)
  })

  it('не координаты: названия, вне диапазонов, минуты больше 60, противоречие знака', () => {
    expect(parseCoordinates('Душанбе')).toEqual([])
    expect(parseCoordinates('Школа 12')).toEqual([])
    expect(parseCoordinates('38.56')).toEqual([])
    expect(parseCoordinates('95, 200')).toEqual([])
    expect(parseCoordinates(`38°75'N 68°10'E`)).toEqual([])
    expect(parseCoordinates('-38 S 68 E')).toEqual([])
    expect(parseCoordinates('38 N 68 N')).toEqual([])
    expect(parseCoordinates('1, 2, 3')).toEqual([])
  })
})

describe('вывод координат', () => {
  const labels = { n: 'с. ш.', s: 'ю. ш.', e: 'в. д.', w: 'з. д.' }

  it('десятичные градусы — «широта, долгота», с полушариями — без знаков', () => {
    expect(formatDecimal({ lon: 68.78, lat: 38.56 })).toBe('38.56000, 68.78000')
    expect(formatHemispheres({ lon: -74.0059, lat: -33.9 }, labels)).toBe(
      '33.90000° ю. ш., 74.00590° з. д.',
    )
  })

  it('градусы, минуты, секунды с полушариями и переносом 60″', () => {
    expect(formatDms({ lon: 68.78, lat: 38.56 }, labels)).toBe('38°33′36″ с. ш. 68°46′48″ в. д.')
    expect(formatDms({ lon: -74.0059, lat: -33.9 }, labels)).toBe('33°54′00″ ю. ш. 74°00′21″ з. д.')
    expect(formatDms({ lon: 10.99999999, lat: 0 }, labels)).toBe('0°00′00″ с. ш. 11°00′00″ в. д.')
  })

  it('численный масштаб по зуму и широте', () => {
    // Экватор, зум 0: 78 271 м в пикселе
    expect(scaleDenominator(0, 0)).toBeCloseTo(295_829_355, -3)
    expect(roundScale(scaleDenominator(10, 38.5))).toBe(230_000)
    expect(roundScale(0)).toBe(0)
    expect(roundScale(1234)).toBe(1200)
    expect(roundScale(87)).toBe(87)
  })
})
