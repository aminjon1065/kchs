import { PassThrough } from 'node:stream'
import { crc32, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  columnLetters,
  type ExportColumn,
  limitBatches,
  localIso,
  neutralizeFormula,
  type RowBatches,
  type RowLimit,
  writeExport,
} from './export-format.js'

const COLUMNS: ExportColumn[] = [
  { name: 'code', label: 'Код', type: 'identifier' },
  { name: 'amount', label: 'Сумма', type: 'decimal' },
  { name: 'day', label: 'Дата', type: 'date' },
  { name: 'at', label: 'Когда', type: 'datetime' },
  { name: 'ok', label: 'Проверено', type: 'boolean' },
  { name: 'tags', label: 'Метки', type: 'multi_select' },
  { name: 'note', label: 'Заметка', type: 'text' },
]

const ROWS = [
  {
    code: 'A-1',
    amount: '12345678901234.56',
    day: new Date('2026-03-01T00:00:00Z'),
    at: new Date('2026-03-01T10:00:00Z'),
    ok: true,
    tags: ['паводок', 'сель'],
    note: '=HYPERLINK("http://x")',
  },
  { code: 'A-2', amount: '-5', day: null, at: null, ok: false, tags: [], note: 'a, "b"\nc' },
]

async function* batches(...groups: Array<Array<Record<string, unknown>>>): RowBatches {
  for (const group of groups) yield group
}

async function render(format: 'csv' | 'json' | 'geojson' | 'xlsx', source: RowBatches, extra = {}) {
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (chunk: Buffer) => chunks.push(chunk))
  await writeExport(format, out, source, {
    columns: COLUMNS,
    timezone: 'Asia/Dushanbe',
    sheetName: 'Происшествия: [март]',
    ...extra,
  })
  out.end()
  return Buffer.concat(chunks)
}

/** Разбор ZIP по центральному каталогу: имя → содержимое (с проверкой CRC и размеров). */
function unzip(archive: Buffer): Map<string, string> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(end).toBeGreaterThan(0)
  const count = archive.readUInt16LE(end + 10)
  let pointer = archive.readUInt32LE(end + 16)
  const files = new Map<string, string>()
  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(pointer)).toBe(0x02014b50)
    const crc = archive.readUInt32LE(pointer + 16)
    const compressed = archive.readUInt32LE(pointer + 20)
    const size = archive.readUInt32LE(pointer + 24)
    const nameLength = archive.readUInt16LE(pointer + 28)
    const offset = archive.readUInt32LE(pointer + 42)
    const name = archive.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    expect(archive.readUInt32LE(offset)).toBe(0x04034b50)
    const dataStart = offset + 30 + archive.readUInt16LE(offset + 26)
    const data = inflateRawSync(archive.subarray(dataStart, dataStart + compressed))
    expect(data.length).toBe(size)
    expect(crc32(data)).toBe(crc)
    // Дескриптор после данных повторяет CRC и размеры
    expect(archive.readUInt32LE(dataStart + compressed)).toBe(0x08074b50)
    expect(archive.readUInt32LE(dataStart + compressed + 4)).toBe(crc)
    files.set(name, data.toString('utf8'))
    pointer += 46 + nameLength
  }
  return files
}

describe('значения выгрузки', () => {
  it('буквы столбцов Excel', () => {
    expect([0, 25, 26, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
  })

  it('формулы нейтрализуются, числа и телефоны — нет', () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1")
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(neutralizeFormula('-2+3+cmd|calc')).toBe("'-2+3+cmd|calc")
    expect(neutralizeFormula('+SUM(A1)')).toBe("'+SUM(A1)")
    expect(neutralizeFormula('-5.25')).toBe('-5.25')
    expect(neutralizeFormula('+992 90 000-00-01')).toBe('+992 90 000-00-01')
    expect(neutralizeFormula('текст')).toBe('текст')
  })

  it('дата и время — ISO со смещением пояса', () => {
    expect(localIso(new Date('2026-03-01T10:00:00Z'), 'Asia/Dushanbe')).toBe(
      '2026-03-01T15:00:00+05:00',
    )
    expect(localIso(new Date('2026-07-01T10:00:00Z'), 'America/New_York')).toBe(
      '2026-07-01T06:00:00-04:00',
    )
  })
})

describe('предел строк выгрузки', () => {
  const rows = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => ({ n: from + index }))

  async function collect(source: RowBatches, max: number) {
    const limit: RowLimit = { rows: 0, truncated: false }
    const seen: number[] = []
    const reported: number[] = []
    for await (const batch of limitBatches(source, max, limit, async (count) => {
      reported.push(count)
    })) {
      seen.push(...batch.map((row) => row.n as number))
    }
    return { limit, seen, reported }
  }

  it('ровно предел — не обрезано; на строку больше — обрезано по пределу', async () => {
    const exact = await collect(batches(rows(3), rows(2, 3)), 5)
    expect(exact.limit).toEqual({ rows: 5, truncated: false })
    expect(exact.reported).toEqual([3, 5])

    const over = await collect(batches(rows(3), rows(3, 3)), 5)
    expect(over.limit).toEqual({ rows: 5, truncated: true })
    expect(over.seen).toEqual([0, 1, 2, 3, 4])

    // Предел совпал с концом пачки, лишняя строка — в следующей
    const boundary = await collect(batches(rows(5), rows(1, 5)), 5)
    expect(boundary.limit).toEqual({ rows: 5, truncated: true })
    expect(boundary.seen).toHaveLength(5)
  })
})

describe('форматы выгрузки', () => {
  it('CSV: BOM, подписи, кавычки, точность чисел, время по поясу, формулы', async () => {
    const text = (await render('csv', batches(ROWS))).toString('utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const lines = text.slice(1).split('\r\n')
    expect(lines[0]).toBe('Код,Сумма,Дата,Когда,Проверено,Метки,Заметка')
    expect(lines[1]).toBe(
      `A-1,12345678901234.56,2026-03-01,2026-03-01T15:00:00+05:00,true,"паводок, сель","'=HYPERLINK(""http://x"")"`,
    )
    expect(lines[2]).toBe('A-2,-5,,,false,,"a, ""b""\nc"')
  })

  it('JSON: массив записей с типами; пустая выгрузка — пустой массив', async () => {
    const parsed = JSON.parse((await render('json', batches(ROWS.slice(0, 1), []))).toString())
    expect(parsed).toEqual([
      {
        code: 'A-1',
        amount: 12345678901234.56,
        day: '2026-03-01',
        at: '2026-03-01T10:00:00.000Z',
        ok: true,
        tags: ['паводок', 'сель'],
        note: '=HYPERLINK("http://x")',
      },
    ])
    expect(JSON.parse((await render('json', batches())).toString())).toEqual([])
  })

  it('GeoJSON: объекты с геометрией и свойствами', async () => {
    const point = { type: 'Point', coordinates: [68.78, 38.56] }
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (chunk: Buffer) => chunks.push(chunk))
    await writeExport(
      'geojson',
      out,
      batches([
        { code: 'A-1', place: point },
        { code: 'A-2', place: null },
      ]),
      {
        columns: [
          { name: 'code', label: 'Код', type: 'identifier' },
          { name: 'place', label: 'Место', type: 'geometry' },
        ],
        timezone: 'Asia/Dushanbe',
        sheetName: 'x',
        geometry: 'place',
      },
    )
    out.end()
    const parsed = JSON.parse(Buffer.concat(chunks).toString())
    expect(parsed.type).toBe('FeatureCollection')
    expect(parsed.features).toEqual([
      { type: 'Feature', geometry: point, properties: { code: 'A-1' } },
      { type: 'Feature', geometry: null, properties: { code: 'A-2' } },
    ])
  })

  it('XLSX: корректный ZIP, лист с заголовком, типы ячеек, даты по поясу', async () => {
    const files = unzip(await render('xlsx', batches(ROWS.slice(0, 1), ROWS.slice(1))))
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ])
    // Имя листа без запрещённых символов
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Происшествия   март" sheetId="1"')
    const sheet = files.get('xl/worksheets/sheet1.xml') ?? ''
    expect(sheet).toContain('<row r="1"><c r="A1" t="inlineStr" s="1"><is><t>Код</t></is></c>')
    expect(sheet).toContain('<c r="B2"><v>12345678901234.56</v></c>')
    // 01.03.2026 — 46082-й день Excel; 15:00 по Душанбе — 0,625 суток
    expect(sheet).toContain('<c r="C2" s="2"><v>46082</v></c>')
    expect(sheet).toContain('<c r="D2" s="3"><v>46082.625</v></c>')
    expect(sheet).toContain('<c r="E2" t="b"><v>1</v></c>')
    expect(sheet).toContain('<c r="F2" t="inlineStr"><is><t>паводок, сель</t></is></c>')
    // Формула в XLSX — просто текст ячейки, спецсимволы экранированы
    expect(sheet).toContain('<t>=HYPERLINK(&quot;http://x&quot;)</t>')
    expect(sheet).toContain('<c r="B3"><v>-5</v></c>')
    expect(sheet).toContain('<t xml:space="preserve">a, &quot;b&quot;\nc</t>')
    // Пустые значения — без ячеек
    expect(sheet).not.toContain('r="C3"')
    expect(sheet.endsWith('</sheetData></worksheet>')).toBe(true)
  })
})
