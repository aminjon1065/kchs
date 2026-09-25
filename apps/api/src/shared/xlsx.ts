import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * Простые таблицы Excel (XLSX) без внешних зависимостей: книга — это ZIP с XML-частями.
 * Чтение — первый лист или лист по имени, ячейки текстом (числа — как записаны в файле);
 * запись — листы со строками, жирной шапкой и шириной столбцов. Для справочников вроде
 * номенклатуры дел (ADR-0135): формулы, стили и даты не разбираются — берётся значение ячейки.
 */

export interface XlsxSheet {
  name: string
  rows: string[][]
}

/** Файл не похож на книгу Excel или повреждён — сообщение для человека. */
export class XlsxError extends Error {}

const MAX_ENTRY_BYTES = 50 * 1024 * 1024

// ─── ZIP ─────────────────────────────────────────────────────────────────────

export interface ZipEntry {
  name: string
  data: Buffer
}

function readZip(buffer: Buffer): Map<string, Buffer> {
  // Конец центрального каталога — в последних 64 КБ с комментарием
  let eocd = -1
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65_557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new XlsxError('Файл не похож на книгу Excel (.xlsx)')
  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new XlsxError('Книга Excel повреждена: каталог архива не читается')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const local = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (size > MAX_ENTRY_BYTES) throw new XlsxError('Книга Excel слишком велика')
    if (buffer.readUInt32LE(local) !== 0x04034b50) {
      throw new XlsxError('Книга Excel повреждена: часть архива не читается')
    }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const raw = buffer.subarray(start, start + compressed)
    if (method === 0) entries.set(name, Buffer.from(raw))
    else if (method === 8) entries.set(name, inflateRawSync(raw))
    else throw new XlsxError('Книга Excel сжата неизвестным способом')
  }
  return entries
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP из частей — для книги Excel (и для проверки чтения книг в тестах). */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const packed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // имена в UTF-8
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

// ─── XML ─────────────────────────────────────────────────────────────────────

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_match, entity: string) => {
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'amp') return '&'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const code =
      entity[1] === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

function encode(text: string): string {
  return (
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Управляющие символы XML 1.0 запрещает — выбрасываются
      // biome-ignore lint/suspicious/noControlCharactersInRegex: отбор запрещённых символов
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  )
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? decode(match[1] as string) : null
}

/** Текст всех `<t>` фрагмента, кроме фонетических подсказок `<rPh>`. */
function texts(fragment: string): string {
  const cleaned = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  let result = ''
  for (const match of cleaned.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
    result += decode(match[1] ?? '')
  }
  return result
}

/** «B12» → 1 (столбец с нуля). */
function columnOf(reference: string): number {
  let column = 0
  for (const char of reference) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) break
    column = column * 26 + (code - 64)
  }
  return column - 1
}

function columnName(index: number): string {
  let name = ''
  let n = index + 1
  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function parseSheet(xml: string, strings: string[]): string[][] {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttr = rowMatch[1] ?? ''
    const number = Number(attribute(`<row${rowAttr}`, 'r') ?? rows.length + 1)
    const cells: string[] = []
    let next = 0
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${cellMatch[1] ?? ''}`
      const reference = attribute(tag, 'r')
      const column = reference ? columnOf(reference) : next
      next = column + 1
      const type = attribute(tag, 't')
      const body = cellMatch[2] ?? ''
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = strings[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = texts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : ''
      else value = raw !== undefined ? decode(raw) : ''
      while (cells.length < column) cells.push('')
      cells[column] = value
    }
    while (rows.length < number - 1) rows.push([])
    rows[number - 1] = cells
  }
  return rows
}

/** Листы книги по порядку; `sheet` — только этот лист (по имени), иначе все. */
export function readXlsx(buffer: Buffer, options: { sheet?: string } = {}): XlsxSheet[] {
  const entries = readZip(buffer)
  const text = (name: string) => entries.get(name)?.toString('utf8') ?? null
  const workbook = text('xl/workbook.xml')
  if (!workbook) throw new XlsxError('Файл не похож на книгу Excel (.xlsx)')
  const relations = new Map<string, string>()
  for (const match of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    const id = attribute(match[0], 'Id')
    const target = attribute(match[0], 'Target')
    if (id && target) {
      relations.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    }
  }
  const strings: string[] = []
  for (const match of (text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    strings.push(texts(match[1] ?? ''))
  }
  const sheets: XlsxSheet[] = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(match[0], 'name') ?? `Лист${sheets.length + 1}`
    if (options.sheet && name !== options.sheet) continue
    const id = attribute(match[0], 'r:id')
    const path = id ? relations.get(id) : undefined
    const xml = path ? text(path) : null
    if (xml === null) continue
    sheets.push({ name, rows: parseSheet(xml, strings) })
  }
  return sheets
}

// ─── Запись ──────────────────────────────────────────────────────────────────

export interface XlsxWriteSheet extends XlsxSheet {
  /** Ширина столбцов в символах. */
  widths?: number[]
  /** Первая строка — жирная закреплённая шапка. */
  header?: boolean
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/

function sheetXml(sheet: XlsxWriteSheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map(
          (width, index) =>
            `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
        )
        .join('')}</cols>`
    : ''
  const pane = sheet.header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : ''
  const rows = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, column) => {
          if (value === '') return ''
          const reference = `${columnName(column)}${rowIndex + 1}`
          const style = sheet.header && rowIndex === 0 ? ' s="1"' : ''
          // Числа — числами, кроме индексов с ведущим нулём («03»): иначе Excel их съест
          if (NUMERIC.test(value) && !/^-?0\d/.test(value)) {
            return `<c r="${reference}"${style}><v>${value}</v></c>`
          }
          return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${encode(value)}</t></is></c>`
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`
}

/** Книга Excel из листов: строки текстом, числа — числами. */
export function writeXlsx(sheets: XlsxWriteSheet[]): Buffer {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map(
      (sheet, index) =>
        `<sheet name="${encode(sheet.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('')}</sheets></workbook>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')}</Types>`
  const root =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  const entry = (name: string, content: string): ZipEntry => ({
    name,
    data: Buffer.from(content, 'utf8'),
  })
  return writeZip([
    entry('[Content_Types].xml', types),
    entry('_rels/.rels', root),
    entry('xl/workbook.xml', workbook),
    entry('xl/_rels/workbook.xml.rels', rels),
    entry('xl/styles.xml', styles),
    ...sheets.map((sheet, index) => entry(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet))),
  ])
}
