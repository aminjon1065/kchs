import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { childNamed, childrenNamed, parseXml, textOf, type XmlElement } from '~/shared/xml.js'
import {
  type CapAlert,
  capDateTime,
  capPolygon,
  renderAtomFeed,
  renderCapAlert,
  renderRssFeed,
  xmlText,
} from './cap.js'

/**
 * Документ CAP 1.2 (ADR-0202): порядок элементов и значения — по схеме OASIS,
 * время со смещением пояса, полигон в порядке «широта,долгота» и замкнутый,
 * экранирование того, что ввёл автор. Схема — фикстура тестов
 * (`test/fixtures/cap/CAP-v1.2.xsd`); без `xmllint` проверка схемой пропускается.
 */
const XSD = fileURLToPath(new URL('../../../../test/fixtures/cap/CAP-v1.2.xsd', import.meta.url))
const hasXmllint = spawnSync('xmllint', ['--version']).status === 0
const workdir = mkdtempSync(path.join(tmpdir(), 'kchs-cap-'))

afterAll(() => rmSync(workdir, { recursive: true, force: true }))

/** Проверка схемой: код выхода и сообщение xmllint. */
function validate(xml: string): { ok: boolean; output: string } {
  const file = path.join(workdir, `alert-${Math.random().toString(36).slice(2)}.xml`)
  writeFileSync(file, xml)
  const run = spawnSync('xmllint', ['--noout', '--schema', XSD, file], { encoding: 'utf8' })
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` }
}

const TZ = 'Asia/Dushanbe'

function sample(overrides: Partial<CapAlert> = {}): CapAlert {
  const area = {
    areaDesc: 'Мургабский район',
    polygons: [
      capPolygon([
        [73.9, 38.1],
        [74.2, 38.1],
        [74.2, 38.3],
        [73.9, 38.3],
      ]) as string,
    ],
    geocodes: [{ valueName: 'ISO 3166-2', value: 'TJ-GB' }],
  }
  const info = (language: string, headline: string) => ({
    language,
    categories: ['Geo'],
    event: 'Сель',
    responseTypes: ['Prepare', 'Monitor'],
    urgency: 'Expected',
    severity: 'Severe',
    certainty: 'Likely',
    effective: capDateTime('2026-10-12T13:00:00Z', TZ),
    expires: capDateTime('2026-10-13T13:00:00Z', TZ),
    senderName: 'КЧС и ГО',
    headline,
    description: 'Ожидается сход селя <в долине> & на дорогах "Памир"',
    instruction: 'Не выезжайте на трассу',
    web: null,
    areas: [area],
  })
  return {
    identifier: 'urn:uuid:5f0c3a52-1111-4a5e-9a00-000000000001',
    sender: 'kchs.example.org',
    sent: capDateTime('2026-10-12T13:00:00Z', TZ),
    status: 'Actual',
    msgType: 'Alert',
    references: null,
    infos: [
      info('tg-TJ', 'Огоҳӣ: сел дар ноҳияи Мурғоб'),
      info('ru-RU', 'Предупреждение: сель в Мургабском районе'),
      info('en-US', 'Warning: mudflow in Murghob district'),
    ],
    ...overrides,
  }
}

describe('CAP 1.2', () => {
  it('время — со смещением пояса установки, без долей секунды и без Z', () => {
    expect(capDateTime('2026-10-12T13:00:00.123Z', TZ)).toBe('2026-10-12T18:00:00+05:00')
    expect(capDateTime('2026-10-12T13:00:00Z', 'UTC')).toBe('2026-10-12T13:00:00+00:00')
  })

  it('полигон — «широта,долгота», кольцо замыкается, вырожденный — нет', () => {
    expect(
      capPolygon([
        [74, 38],
        [75, 38],
        [75, 39],
      ]),
    ).toBe('38,74 38,75 39,75 38,74')
    expect(capPolygon([[74, 38]])).toBeNull()
  })

  it('экранирует разметку и выбрасывает символы вне XML 1.0', () => {
    expect(xmlText('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;')
    expect(xmlText(`x${String.fromCharCode(0)}y${String.fromCharCode(0x1b)}z`)).toBe('xyz')
    expect(xmlText(`ok${String.fromCharCode(0xd800)}`)).toBe('ok')
  })

  it('документ читается разборщиком: alert, блоки по языкам, область', () => {
    const root = parseXml(renderCapAlert(sample()))
    expect(root.name).toBe('alert')
    expect(textOf(childNamed(root, 'scope'))).toBe('Public')
    const infos = childrenNamed(root, 'info')
    expect(infos.map((info) => textOf(childNamed(info, 'language')))).toEqual([
      'tg-TJ',
      'ru-RU',
      'en-US',
    ])
    const ru = infos[1] as XmlElement
    expect(textOf(childNamed(ru, 'description'))).toBe(
      'Ожидается сход селя <в долине> & на дорогах "Памир"',
    )
    const area = childNamed(ru, 'area') as XmlElement
    expect(textOf(childNamed(area, 'polygon'))).toBe(
      '38.1,73.9 38.1,74.2 38.3,74.2 38.3,73.9 38.1,73.9',
    )
  })

  it.skipIf(!hasXmllint)('проходит схему OASIS — и новое, и отмена со ссылкой', () => {
    const alert = validate(renderCapAlert(sample()))
    expect(alert.ok, alert.output).toBe(true)
    const cancel = validate(
      renderCapAlert(
        sample({
          msgType: 'Cancel',
          status: 'Exercise',
          references: `kchs.example.org,urn:uuid:1,${capDateTime('2026-10-11T10:00:00Z', TZ)}`,
        }),
      ),
    )
    expect(cancel.ok, cancel.output).toBe(true)
  })

  it.skipIf(!hasXmllint)('проверка схемой настоящая: неверный документ отклоняется', () => {
    const wrongType = validate(renderCapAlert(sample({ msgType: 'Bogus' })))
    expect(wrongType.ok).toBe(false)
    const zulu = validate(renderCapAlert(sample({ sent: '2026-10-12T13:00:00Z' })))
    expect(zulu.ok).toBe(false)
  })
})

describe('ленты', () => {
  const entries = [
    {
      identifier: 'urn:uuid:5f0c3a52-1111-4a5e-9a00-000000000001',
      title: 'Сель <Мургаб>',
      summary: 'Описание & подробности',
      sent: new Date('2026-10-12T13:00:00Z'),
      capUrl: 'https://kchs.example.org/api/v1/public/cap/1.xml',
    },
  ]

  it('Atom: запись ссылается на CAP', () => {
    const feed = parseXml(
      renderAtomFeed({
        id: 'https://kchs.example.org/api/v1/public/cap/feed.xml',
        title: 'Предупреждения',
        selfUrl: 'https://kchs.example.org/api/v1/public/cap/feed.xml',
        updated: entries[0]?.sent as Date,
        author: 'КЧС и ГО',
        language: 'ru',
        entries,
      }),
    )
    const entry = childNamed(feed, 'entry') as XmlElement
    expect(textOf(childNamed(entry, 'title'))).toBe('Сель <Мургаб>')
    expect(childNamed(entry, 'link')?.attributes.type).toBe('application/cap+xml')
  })

  it('RSS: элемент с guid-идентификатором CAP', () => {
    const rss = parseXml(
      renderRssFeed({
        title: 'Огоҳиҳо',
        link: 'https://kchs.example.org/api/v1/public/cap/rss/tg.xml',
        description: 'КҲФ',
        language: 'tg-tj',
        entries,
      }),
    )
    const item = childNamed(childNamed(rss, 'channel') as XmlElement, 'item') as XmlElement
    expect(textOf(childNamed(item, 'guid'))).toBe(entries[0]?.identifier)
    expect(textOf(childNamed(item, 'pubDate'))).toBe('Mon, 12 Oct 2026 13:00:00 GMT')
  })
})
