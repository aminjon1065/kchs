import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FeedBbox } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import {
  coerceValue,
  dateTimeOf,
  discoverPaths,
  flattenRecord,
  geometryBbox,
  isoDateTime,
  keyText,
  mappedValue,
  normalizeGeometry,
  parseCsv,
  parseFeed,
  recordGeometry,
  translateValue,
  valueAt,
  withinBbox,
} from './feed-parse.js'

/**
 * Разбор лент (ADR-0132) на живых ответах служб — USGS FDSN GeoJSON, EMSC FDSN
 * JSON, GDACS geteventlist и NASA FIRMS VIIRS CSV, урезанных до десятка записей.
 */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../test/fixtures/feeds/${name}`, import.meta.url)))

/** Область Таджикистана с запасом — как в настройке ленты пакета ЧС. */
const TAJIKISTAN: FeedBbox = [67.3, 36.6, 75.2, 41.1]

describe('USGS: землетрясения GeoJSON', () => {
  const records = parseFeed(fixture('usgs.geojson'), 'geojson', null)

  it('объекты коллекции — записи ленты', () => {
    expect(records).toHaveLength(10)
    expect(valueAt(records[0], 'id')).toBe('us6000tx16')
    expect(valueAt(records[0], 'properties.mag')).toBe(4.7)
  })

  it('геометрия — двумерная точка: глубина очага отброшена', () => {
    const geometry = recordGeometry(records[0] as Record<string, unknown>, { kind: 'feature' })
    expect(geometry).toEqual({ type: 'Point', coordinates: [71.768, 37.2772] })
    expect(withinBbox(geometry as never, TAJIKISTAN)).toBe(true)
  })

  it('время в миллисекундах эпохи ложится в поле даты-времени', () => {
    const value = mappedValue(
      records[0] as Record<string, unknown>,
      { kind: 'path', path: 'properties.time', transform: 'auto' },
      'datetime',
    )
    expect(value).toBe(new Date(1790142371056).toISOString())
  })

  it('пути записей — с типами и примерами для сопоставления', () => {
    const paths = new Map(discoverPaths(records).map((info) => [info.path, info]))
    expect(paths.get('properties.mag')?.type).toBe('number')
    expect(paths.get('properties.time')?.type).toBe('datetime')
    expect(paths.get('geometry')?.type).toBe('geometry')
    expect(paths.get('id')?.type).toBe('text')
    expect(paths.get('properties.place')?.filled).toBe(10)
  })
})

describe('EMSC: землетрясения FDSN JSON', () => {
  const records = parseFeed(fixture('emsc.json'), 'geojson', null)

  it('время ISO с поясом и магнитуда — по путям свойств', () => {
    expect(records).toHaveLength(10)
    const first = records[0] as Record<string, unknown>
    expect(
      mappedValue(first, { kind: 'path', path: 'properties.time', transform: 'auto' }, 'datetime'),
    ).toBe('2026-09-23T05:46:11.190Z')
    expect(
      mappedValue(
        first,
        { kind: 'path', path: 'properties.unid', transform: 'auto' },
        'identifier',
      ),
    ).toBe('20260923_0000067')
    // Отрицательная глубина в третьей координате не мешает точке
    expect(recordGeometry(first, { kind: 'feature' })).toEqual({
      type: 'Point',
      coordinates: [71.815, 37.2518],
    })
  })
})

describe('GDACS: мировые предупреждения', () => {
  const records = parseFeed(fixture('gdacs.geojson'), 'geojson', null)

  it('вложенные свойства и время без пояса — всемирное', () => {
    const first = records[0] as Record<string, unknown>
    expect(valueAt(first, 'properties.url.report')).toMatch(/^https:\/\/www\.gdacs\.org\/report/)
    expect(valueAt(first, 'properties.affectedcountries.0.iso3')).toBe('MEX')
    expect(
      mappedValue(
        first,
        { kind: 'path', path: 'properties.fromdate', transform: 'auto' },
        'datetime',
      ),
    ).toBe('2026-09-21T03:00:00.000Z')
    expect(
      mappedValue(
        first,
        { kind: 'path', path: 'properties.severitydata.severity', transform: 'auto' },
        'number',
      ),
    ).toBeCloseTo(287.0352)
  })

  it('события вне области отбираются', () => {
    const inside = records.filter((record) => {
      const geometry = recordGeometry(record, { kind: 'feature' })
      return geometry !== null && withinBbox(geometry, TAJIKISTAN)
    })
    expect(inside).toHaveLength(0)
  })
})

describe('NASA FIRMS: термоточки CSV', () => {
  const records = parseFeed(fixture('firms.csv'), 'csv', null)

  it('строки CSV — записи со столбцами', () => {
    expect(records).toHaveLength(14)
    expect(Object.keys(records[0] as object)).toContain('acq_time')
  })

  it('точка из широты и долготы; область оставляет свои', () => {
    const inside = records.filter((record) => {
      const geometry = recordGeometry(record, { kind: 'latlon', lat: 'latitude', lon: 'longitude' })
      return geometry !== null && withinBbox(geometry, TAJIKISTAN)
    })
    expect(inside).toHaveLength(8)
  })

  it('дата и время в двух столбцах, ключ — шаблоном', () => {
    const first = records[0] as Record<string, string>
    const at = mappedValue(
      first,
      { kind: 'date_time', date: 'acq_date', time: 'acq_time' },
      'datetime',
    )
    const [hours, minutes] = [first.acq_time?.slice(0, 2), first.acq_time?.slice(2)]
    expect(at).toBe(`${first.acq_date}T${hours}:${minutes}:00.000Z`)
    const key = mappedValue(
      first,
      { kind: 'template', template: '{latitude}_{longitude}_{acq_date}_{acq_time}_{satellite}' },
      'identifier',
    )
    expect(key).toBe(
      `${first.latitude}_${first.longitude}_${first.acq_date}_${first.acq_time}_${first.satellite}`,
    )
  })
})

describe('форматы и ошибки разбора', () => {
  it('CSV: кавычки, разделитель «;», перевод строки в поле, столбец с точкой', () => {
    const records = parseCsv('"код";"a.b";описание\n1;2;"строка ""в кавычках""\nвторая"\n\n')
    expect(records).toEqual([{ код: '1', 'a.b': '2', описание: 'строка "в кавычках"\nвторая' }])
    expect(valueAt(records[0], 'a.b')).toBe('2')
  })

  it('JSON: массив по пути или в корне', () => {
    const body = JSON.stringify({ data: { items: [{ id: 1 }, { id: 2 }, 'мусор'] } })
    expect(parseFeed(body, 'json', 'data.items')).toEqual([{ id: 1 }, { id: 2 }])
    expect(() => parseFeed(body, 'json', null)).toThrow(/не массив записей/)
    expect(() => parseFeed(body, 'json', 'data.nothing')).toThrow(/нет массива записей/)
  })

  it('не тот формат — понятная причина', () => {
    expect(() => parseFeed('{"a":1}', 'csv', null)).toThrow(/не CSV/)
    expect(() => parseFeed('<html>', 'geojson', null)).toThrow(/не JSON/)
    expect(() => parseFeed('[1,2]', 'geojson', null)).toThrow(/не GeoJSON/)
  })

  it('путь не читает прототип объекта', () => {
    expect(valueAt({ a: 1 }, '__proto__.polluted')).toBeUndefined()
    expect(valueAt({ a: { b: [10, 20] } }, 'a.b.1')).toBe(20)
    expect(valueAt({ a: { b: [10, 20] } }, 'a.b.x')).toBeUndefined()
  })
})

describe('значения и геометрия', () => {
  it('приведение по типу поля', () => {
    expect(coerceValue('', 'auto', 'text')).toBeNull()
    expect(coerceValue('4,7', 'auto', 'number')).toBe(4.7)
    expect(coerceValue('да', 'auto', 'boolean')).toBe(true)
    expect(coerceValue('false', 'auto', 'boolean')).toBe(false)
    expect(coerceValue('2026-09-23T05:46:11Z', 'auto', 'date')).toBe('2026-09-23')
    expect(coerceValue(1790142371, 'epoch_s', 'datetime')).toBe(
      new Date(1790142371000).toISOString(),
    )
    expect(coerceValue(1790142371056, 'epoch_ms', 'date')).toBe('2026-09-23')
    expect(coerceValue({ a: 1 }, 'text', 'text')).toBe('{"a":1}')
    expect(coerceValue('a, b', 'auto', 'multi_select')).toEqual(['a', 'b'])
    // Не удалось привести — значение остаётся: проверка строки назовёт поле
    expect(coerceValue('не число', 'auto', 'integer')).toBe('не число')
  })

  it('время: ISO без пояса — всемирное, RFC 2822, число эпохи', () => {
    expect(isoDateTime('2026-09-21T03:00:00')).toBe('2026-09-21T03:00:00.000Z')
    expect(isoDateTime('2026-09-21 03:00')).toBe('2026-09-21T03:00:00.000Z')
    expect(isoDateTime('2026-09-21T08:00:00+05:00')).toBe('2026-09-21T03:00:00.000Z')
    expect(isoDateTime('Mon, 21 Sep 2026 03:00:00 GMT')).toBe('2026-09-21T03:00:00.000Z')
    expect(isoDateTime('вчера')).toBeNull()
    expect(dateTimeOf('2026-09-23', '517')).toBe('2026-09-23T05:17:00.000Z')
    expect(dateTimeOf('2026-09-23', 45)).toBe('2026-09-23T00:45:00.000Z')
    expect(dateTimeOf('23.09.2026', '0517')).toBeNull()
  })

  it('геометрия: тип и координаты проверяются, охват — по всем точкам', () => {
    expect(normalizeGeometry({ type: 'Point', coordinates: [200, 10] })).toBeNull()
    expect(normalizeGeometry({ type: 'GeometryCollection', geometries: [] })).toBeNull()
    const polygon = normalizeGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [70, 38, 5],
          [71, 38, 5],
          [71, 39, 5],
          [70, 38, 5],
        ],
      ],
    })
    expect(polygon?.coordinates).toEqual([
      [
        [70, 38],
        [71, 38],
        [71, 39],
        [70, 38],
      ],
    ])
    expect(geometryBbox(polygon as never)).toEqual([70, 38, 71, 39])
    expect(withinBbox(polygon as never, [70.5, 38.5, 80, 45])).toBe(true)
    expect(withinBbox(polygon as never, [72, 38, 80, 45])).toBe(false)
  })

  it('ключ: текстом, пусто — записи без ключа', () => {
    expect(keyText(12)).toBe('12')
    expect(keyText('  us6000tx16 ')).toBe('us6000tx16')
    expect(keyText('')).toBeNull()
    expect(keyText(null)).toBeNull()
  })

  it('развёртка записи: геометрия целиком, короткие массивы по номерам', () => {
    const flat = flattenRecord({
      id: 'x',
      geometry: { type: 'Point', coordinates: [70, 38] },
      properties: { tags: ['a', 'b'], nested: [{ iso3: 'TJK' }] },
    })
    expect(flat).toEqual({
      id: 'x',
      geometry: { type: 'Point', coordinates: [70, 38] },
      'properties.tags.0': 'a',
      'properties.tags.1': 'b',
      'properties.nested.0.iso3': 'TJK',
    })
  })
})

describe('словарь значений ленты', () => {
  it('код ленты превращается в значение поля: точно, без регистра, запасной', () => {
    const map = { EQ: 'earthquake', FL: 'flood', '*': 'other' }
    expect(translateValue('EQ', map)).toBe('earthquake')
    expect(translateValue('fl', map)).toBe('flood')
    expect(translateValue('XX', map)).toBe('other')
    expect(translateValue('XX', { EQ: 'earthquake' })).toBe('XX')
    expect(translateValue(null, map)).toBeNull()
  })

  it('сопоставление по пути применяет словарь до приведения типа', () => {
    const record = { properties: { eventtype: 'EQ', alertlevel: 'Orange' } }
    expect(
      mappedValue(
        record,
        {
          kind: 'path',
          path: 'properties.alertlevel',
          transform: 'auto',
          map: { green: 'green', orange: 'orange', red: 'red' },
        },
        'select',
      ),
    ).toBe('orange')
  })
})
