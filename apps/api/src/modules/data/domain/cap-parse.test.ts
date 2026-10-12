import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { capThreadKey, orderCapRecords, parseCapDocument } from './cap-parse.js'
import { discoverPaths, mappedValue, parseFeed, valueAt } from './feed-parse.js'

/** Образцы стандарта OASIS CAP 1.2 (приложение A) и живая лента GDACS. */
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../test/fixtures/feeds/cap/${name}`, import.meta.url), 'utf8')

describe('лента CAP 1.2 (ADR-0201)', () => {
  it('сообщение с многоугольником: поля, геокоды и геометрия в порядке GeoJSON', () => {
    const { alerts, links, skipped } = parseCapDocument(fixture('oasis-thunderstorm.xml'), null)
    expect(links).toEqual([])
    expect(skipped).toBe(0)
    expect(alerts).toHaveLength(1)
    const [alert] = alerts
    expect(alert).toMatchObject({
      key: 'KSTO1055887203,2003-06-17T14:57:00-07:00',
      identifier: 'KSTO1055887203',
      sender: 'KSTO@NWS.NOAA.GOV',
      status: 'Actual',
      msgType: 'Alert',
      language: 'en-US',
    })
    expect(valueAt(alert, 'info.event')).toBe('SEVERE THUNDERSTORM')
    expect(valueAt(alert, 'info.severity')).toBe('Severe')
    expect(valueAt(alert, 'info.eventCode.SAME')).toBe('SVR')
    expect(valueAt(alert, 'area.geocode.SAME')).toBe('006109,006009,006003')
    // CAP пишет «широта,долгота» — GeoJSON «долгота, широта»
    expect(alert?.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [-120.14, 38.47],
          [-119.95, 38.34],
          [-119.74, 38.52],
          [-119.89, 38.62],
          [-120.14, 38.47],
        ],
      ],
    })
    expect(
      mappedValue(alert as never, { kind: 'path', path: 'sent', transform: 'auto' }, 'datetime'),
    ).toBe('2003-06-17T21:57:00.000Z')
  })

  it('уточнение (`Update`) пишется в строку первичного сообщения по `references`; круг нулевого радиуса — точка', () => {
    const [alert] = parseCapDocument(fixture('oasis-earthquake-update.xml'), null).alerts
    expect(alert).toMatchObject({
      msgType: 'Update',
      identifier: 'TRI13970876.2',
      key: 'TRI13970876.1,2003-06-11T20:30:00-07:00',
    })
    expect(valueAt(alert, 'info.parameter.Magnitude')).toBe('3.4 Ml')
    expect(alert?.geometry).toEqual({ type: 'Point', coordinates: [-115.5527, 32.9525] })
  })

  it('ключ нити — самое раннее из сообщений, на которые ссылается уточнение', () => {
    expect(
      capThreadKey('C', '2026-10-12T10:00:00+05:00', [
        { sender: 's', identifier: 'B', sent: '2026-10-12T09:00:00+05:00' },
        { sender: 's', identifier: 'A', sent: '2026-10-12T08:00:00+05:00' },
      ]),
    ).toBe('A,2026-10-12T08:00:00+05:00')
  })

  it('несколько блоков `info`: выбор по языку, остальные — по пути `lang.<код>`', () => {
    const [alert] = parseCapDocument(fixture('oasis-amber-multilingual.xml'), null).alerts
    // Ни русского, ни таджикского — английский
    expect(valueAt(alert, 'info.headline')).toBe('Amber Alert in Los Angeles County')
    expect(valueAt(alert, 'lang.es.headline')).toBe('Alerta Amber en el condado de Los Ángeles')
    expect(alert?.geometry).toBeNull()
    const russian = fixture('oasis-amber-multilingual.xml').replace(
      '<language>es-US</language>',
      '<language>ru-TJ</language>',
    )
    const [preferred] = parseCapDocument(russian, null).alerts
    expect(valueAt(preferred, 'info.headline')).toBe('Alerta Amber en el condado de Los Ángeles')
    expect(valueAt(preferred, 'language')).toBe('ru-TJ')
  })

  it('индекс RSS GDACS: сообщения внутри записей, без перехода по ссылкам', () => {
    const document = parseCapDocument(
      fixture('gdacs-cap.rss.xml'),
      'https://www.gdacs.org/xml/gdacs_cap.xml',
    )
    expect(document.links).toEqual([])
    expect(document.alerts).toHaveLength(2)
    const [first] = document.alerts
    expect(first).toMatchObject({ identifier: 'GDACS_EQ_1571039_1739492', status: 'Actual' })
    expect(valueAt(first, 'info.parameter.alertlevel')).toBe('Green')
    expect(valueAt(first, 'info.parameter.eventtype')).toBe('EQ')
    expect(first?.geometry).toMatchObject({ type: 'Polygon' })
    // Пути для сопоставления в мастере ленты
    const paths = discoverPaths(document.alerts).map((path) => path.path)
    expect(paths).toEqual(
      expect.arrayContaining(['key', 'info.headline', 'info.parameter.alertlevel', 'geometry']),
    )
  })

  it('индекс Atom со ссылками: адреса — абсолютные, без повторов и ссылки на себя', () => {
    const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="https://hydromet.example.tj/cap/index.atom"/>
  <entry><id>1</id><link rel="alternate" type="text/html" href="/page/1"/><link type="application/cap+xml" href="/cap/1.xml"/></entry>
  <entry><id>2</id><link href="https://hydromet.example.tj/cap/2.xml"/></entry>
  <entry><id>3</id><link href="/cap/1.xml"/></entry>
  <entry><id>4</id><link href="javascript:alert(1)"/></entry>
</feed>`
    const document = parseCapDocument(atom, 'https://hydromet.example.tj/cap/index.atom')
    expect(document.links).toEqual([
      'https://hydromet.example.tj/cap/1.xml',
      'https://hydromet.example.tj/cap/2.xml',
    ])
  })

  it('тест, черновик, служебные, подтверждения и ошибки — не записи', () => {
    const base = fixture('oasis-thunderstorm.xml')
    for (const [from, to] of [
      ['<status>Actual</status>', '<status>Test</status>'],
      ['<status>Actual</status>', '<status>Draft</status>'],
      ['<msgType>Alert</msgType>', '<msgType>Ack</msgType>'],
    ] as const) {
      const document = parseCapDocument(base.replace(from, to), null)
      expect(document).toMatchObject({ alerts: [], skipped: 1 })
    }
    const exercise = parseCapDocument(
      base.replace('<status>Actual</status>', '<status>Exercise</status>'),
      null,
    )
    expect(exercise.alerts).toHaveLength(1)
  })

  it('уточнение после первичного в одном ответе — позже по времени, остаётся последним', () => {
    const ordered = orderCapRecords([
      { key: 'A', sent: '2026-10-12T10:00:00Z', msgType: 'Update' },
      { key: 'A', sent: '2026-10-12T08:00:00Z', msgType: 'Alert' },
    ])
    expect(ordered.map((record) => record.msgType)).toEqual(['Alert', 'Update'])
  })

  it('не CAP — понятная ошибка; формат `cap` у общего разборщика — только сообщения документа', () => {
    expect(() => parseCapDocument('<html><body/></html>', null)).toThrow(/не CAP/)
    expect(() => parseCapDocument('{"a":1}', null)).toThrow(/не XML/)
    expect(parseFeed(fixture('oasis-thunderstorm.xml'), 'cap', null)).toHaveLength(1)
  })
})
