import { once } from 'node:events'
import type { Writable } from 'node:stream'
import type { DatasetExportFormat, FieldType } from '@kchs/contracts'
import { CSV_BOM } from '~/shared/csv.js'
import { ZipWriter } from './zip.js'

/** Столбец выгрузки: имя в строке результата, подпись для заголовка, тип поля. */
export interface ExportColumn {
  name: string
  label: string
  type: FieldType
}

/** Строки результата пачками — как их отдаёт курсор postgres.js. */
export type RowBatches = AsyncIterable<ReadonlyArray<Record<string, unknown>>>

export interface ExportFormatOptions {
  columns: ExportColumn[]
  /** Пояс запросившего: дата и время в CSV и XLSX — по его часам. */
  timezone: string
  /** Лист XLSX. */
  sheetName: string
  /** Поле геометрии для GeoJSON. */
  geometry?: string
}

const NUMERIC = new Set<string>(['integer', 'number', 'decimal', 'money', 'percent', 'duration'])
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000
/** Предел текста ячейки Excel. */
const EXCEL_CELL_MAX = 32_767
/** Недопустимые в XML 1.0 символы (управляющие, кроме табуляции и переводов строки). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: удаляем именно управляющие символы
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g
const PLAIN_NUMBER = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/

/** Запись в поток с ожиданием `drain`: память не растёт на миллионе строк. */
class Output {
  constructor(private readonly out: Writable) {}
  async write(text: string): Promise<void> {
    if (!this.out.write(text, 'utf8')) await once(this.out, 'drain')
  }
}

// ─── Значения ────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Время на часах пояса: поля даты и времени и смещение от UTC в минутах. */
function wallClock(instant: Date, timezone: string) {
  let format = formatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timezone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  const wall = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
  const whole = instant.getTime() - instant.getUTCMilliseconds()
  return { wall, offset: Math.round((wall - whole) / 60_000) }
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0')

/** ISO 8601 с поясом запросившего: `2026-03-01T15:00:00+05:00`. */
export function localIso(instant: Date, timezone: string): string {
  const { wall, offset } = wallClock(instant, timezone)
  const local = new Date(wall).toISOString().slice(0, 19)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

/** Дата без времени: `YYYY-MM-DD` (postgres.js отдаёт полночь UTC). */
function isoDate(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  return asDate(value)?.toISOString().slice(0, 10) ?? null
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** Текст значения для CSV и XLSX: списки — через запятую, объекты — JSON. */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.map((item) => (item === null ? '' : String(item))).join(', ')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Значение для CSV: числа — как в базе (без потери точности), время — по поясу. */
function csvValue(value: unknown, type: FieldType, timezone: string): string {
  if (value === null || value === undefined) return ''
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'date') return isoDate(value) ?? text(value)
  if (type === 'datetime') {
    const instant = asDate(value)
    return instant ? localIso(instant, timezone) : text(value)
  }
  if (NUMERIC.has(type)) return String(value)
  return text(value)
}

/**
 * Защита от формул при открытии CSV в табличном редакторе (CSV injection):
 * значение, которое начинается с `=`, `@`, табуляции или перевода строки, либо
 * с `+`/`-`, но не является числом, получает ведущий апостроф. Отрицательные
 * числа и телефоны `+992 90 000-00-01` остаются как есть — в отличие от строгой
 * выгрузки журнала аудита (`shared/csv.ts`), здесь это данные для анализа.
 */
export function neutralizeFormula(value: string): string {
  const first = value[0]
  if (first === '=' || first === '@' || first === '\t' || first === '\r') return `'${value}`
  if (first === '-' && !PLAIN_NUMBER.test(value)) return `'${value}`
  if (first === '+' && !PLAIN_NUMBER.test(value.replace(/[\s()-]/g, ''))) return `'${value}`
  return value
}

function csvCell(value: string): string {
  const safe = neutralizeFormula(value)
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Значение для JSON: числа — числами, дата — `YYYY-MM-DD`, время — ISO UTC. */
function jsonValue(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null
  if (NUMERIC.has(type)) return asNumber(value)
  if (type === 'date') return isoDate(value)
  if (value instanceof Date) return value.toISOString()
  return value
}

// ─── CSV, JSON, GeoJSON ──────────────────────────────────────────────────────

/** Строки пачки склеиваются в один кусок: запись в поток — на пачку, а не на строку. */
async function writeCsv(out: Output, batches: RowBatches, options: ExportFormatOptions) {
  await out.write(
    `${CSV_BOM}${options.columns.map((column) => csvCell(column.label)).join(',')}\r\n`,
  )
  for await (const batch of batches) {
    let chunk = ''
    for (const row of batch) {
      chunk += options.columns
        .map((column) => csvCell(csvValue(row[column.name], column.type, options.timezone)))
        .join(',')
      chunk += '\r\n'
    }
    await out.write(chunk)
  }
}

async function writeJson(out: Output, batches: RowBatches, options: ExportFormatOptions) {
  await out.write('[')
  let first = true
  for await (const batch of batches) {
    let chunk = ''
    for (const row of batch) {
      const record: Record<string, unknown> = {}
      for (const column of options.columns) {
        record[column.name] = jsonValue(row[column.name], column.type)
      }
      chunk += `${first ? '\n' : ',\n'}${JSON.stringify(record)}`
      first = false
    }
    await out.write(chunk)
  }
  await out.write(first ? ']\n' : '\n]\n')
}

async function writeGeoJson(out: Output, batches: RowBatches, options: ExportFormatOptions) {
  const geometry = options.geometry
  if (!geometry) throw new Error('Для GeoJSON нужно поле геометрии')
  const properties = options.columns.filter((column) => column.name !== geometry)
  await out.write('{"type":"FeatureCollection","features":[')
  let first = true
  for await (const batch of batches) {
    let chunk = ''
    for (const row of batch) {
      const props: Record<string, unknown> = {}
      for (const column of properties) props[column.name] = jsonValue(row[column.name], column.type)
      const feature = { type: 'Feature', geometry: row[geometry] ?? null, properties: props }
      chunk += `${first ? '\n' : ',\n'}${JSON.stringify(feature)}`
      first = false
    }
    await out.write(chunk)
  }
  await out.write(first ? ']}\n' : '\n]}\n')
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

const STYLE = { header: 1, date: 2, datetime: 3, time: 4 } as const

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>'

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>'

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/** Стили: 0 — обычный, 1 — заголовок, 2 — дата, 3 — дата и время, 4 — время (форматы Excel по языку системы). */
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="21" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

function xmlText(value: string): string {
  return value
    .replace(XML_INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Буквы столбца Excel: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let result = ''
  let rest = index + 1
  while (rest > 0) {
    const remainder = (rest - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    rest = Math.floor((rest - 1) / 26)
  }
  return result
}

/** Имя листа: не длиннее 31 символа, без `[]:*?/\`. */
function sheetName(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31)
  return clean || 'Sheet1'
}

function stringCell(ref: string, value: string, style = 0): string {
  const clipped = value.length > EXCEL_CELL_MAX ? value.slice(0, EXCEL_CELL_MAX) : value
  const escaped = xmlText(clipped)
  const preserve = escaped !== escaped.trim() || /\n/.test(escaped) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${preserve}>${escaped}</t></is></c>`
}

function numberCell(ref: string, value: number, style = 0): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`
}

/** Ячейка по типу поля; пустое значение — без ячейки. */
function xlsxCell(ref: string, value: unknown, type: FieldType, timezone: string): string {
  if (value === null || value === undefined) return ''
  if (NUMERIC.has(type)) {
    const number = asNumber(value)
    return number === null ? stringCell(ref, text(value)) : numberCell(ref, number)
  }
  if (type === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (type === 'date') {
    const day = isoDate(value)
    if (!day) return stringCell(ref, text(value))
    return numberCell(ref, (Date.parse(`${day}T00:00:00Z`) - EXCEL_EPOCH) / DAY_MS, STYLE.date)
  }
  if (type === 'datetime') {
    const instant = asDate(value)
    if (!instant) return stringCell(ref, text(value))
    const { wall } = wallClock(instant, timezone)
    return numberCell(ref, (wall - EXCEL_EPOCH) / DAY_MS, STYLE.datetime)
  }
  if (type === 'time' && typeof value === 'string') {
    const [hours = 0, minutes = 0, seconds = 0] = value.split(':').map(Number)
    const fraction = (hours * 3600 + minutes * 60 + seconds) / 86_400
    return Number.isFinite(fraction)
      ? numberCell(ref, fraction, STYLE.time)
      : stringCell(ref, text(value))
  }
  return stringCell(ref, text(value))
}

async function writeXlsx(out: Writable, batches: RowBatches, options: ExportFormatOptions) {
  const zip = new ZipWriter(out)
  const letters = options.columns.map((_, index) => columnLetters(index))
  const name = sheetName(options.sheetName)

  await zip.add('[Content_Types].xml', [CONTENT_TYPES])
  await zip.add('_rels/.rels', [ROOT_RELS])
  await zip.add('xl/workbook.xml', [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  ])
  await zip.add('xl/_rels/workbook.xml.rels', [WORKBOOK_RELS])
  await zip.add('xl/styles.xml', [STYLES])

  const columns = options.columns
  async function* sheet(): AsyncGenerator<string> {
    const width =
      columns.length > 0
        ? `<cols><col min="1" max="${columns.length}" width="18" customWidth="1"/></cols>`
        : ''
    yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      `${width}<sheetData>`
    yield `<row r="1">${columns
      .map((column, index) => stringCell(`${letters[index]}1`, column.label, STYLE.header))
      .join('')}</row>`
    let rowNumber = 1
    for await (const batch of batches) {
      let chunk = ''
      for (const row of batch) {
        rowNumber += 1
        chunk += `<row r="${rowNumber}">`
        for (const [index, column] of columns.entries()) {
          chunk += xlsxCell(
            `${letters[index]}${rowNumber}`,
            row[column.name],
            column.type,
            options.timezone,
          )
        }
        chunk += '</row>'
      }
      yield chunk
    }
    yield '</sheetData></worksheet>'
  }
  await zip.add('xl/worksheets/sheet1.xml', sheet())
  await zip.close()
}

/** Сколько строк пропущено дальше и были ли строки сверх предела. */
export interface RowLimit {
  rows: number
  truncated: boolean
}

/**
 * Пачки строк не больше `max` всего. Строк больше — `limit.truncated`
 * (компилятор отдаёт на строку больше предела); `onRows` — после каждой пачки.
 */
export async function* limitBatches(
  source: RowBatches,
  max: number,
  limit: RowLimit,
  onRows?: (rows: number) => Promise<void>,
): AsyncGenerator<ReadonlyArray<Record<string, unknown>>> {
  for await (const batch of source) {
    const room = max - limit.rows
    if (batch.length > room) {
      limit.truncated = true
      limit.rows += room
      if (room > 0) yield batch.slice(0, room)
      return
    }
    limit.rows += batch.length
    yield batch
    await onRows?.(limit.rows)
  }
}

/** Выгрузка строк в поток в выбранном формате; поток закрывает вызывающий. */
export async function writeExport(
  format: DatasetExportFormat,
  out: Writable,
  batches: RowBatches,
  options: ExportFormatOptions,
): Promise<void> {
  if (format === 'xlsx') return writeXlsx(out, batches, options)
  const output = new Output(out)
  if (format === 'csv') return writeCsv(output, batches, options)
  if (format === 'json') return writeJson(output, batches, options)
  return writeGeoJson(output, batches, options)
}
