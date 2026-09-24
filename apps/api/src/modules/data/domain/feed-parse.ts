import type {
  FeedBbox,
  FeedFormat,
  FeedGeometry,
  FeedPathInfo,
  FeedTransform,
  FeedValue,
  FeedValueType,
  StoredFieldType,
} from '@kchs/contracts'
import { errors } from '~/shared/errors.js'

/**
 * Разбор ленты по адресу (ADR-0132) — чистые функции без базы и сети: записи
 * из GeoJSON, JSON или CSV, значения по путям, приведение к типам полей
 * датасета, геометрия записи и её охват. Сервис ленты (`feed-service.ts`) берёт
 * отсюда разбор и пишет строки.
 */

export type FeedRecord = Record<string, unknown>

/** Геометрия GeoJSON двумерная, WGS 84. */
export interface FeedGeometryValue {
  type: string
  coordinates: unknown
}

/** Части пути, которые не читаются: доступ к прототипу объекта. */
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Значение по пути `a.b.0.c`; нет — undefined. У записи CSV путь — имя столбца
 * целиком, даже с точкой внутри.
 */
export function valueAt(record: unknown, path: string): unknown {
  if (isObject(record) && Object.hasOwn(record, path)) return record[path]
  let current: unknown = record
  for (const part of path.split('.')) {
    if (UNSAFE.has(part)) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0) return undefined
      current = current[index]
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, part)) return undefined
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}

// ── Форматы ──────────────────────────────────────────────────────────────────

/** Разделитель CSV по строке заголовка: запятая, точка с запятой или табуляция. */
function delimiterOf(header: string): string {
  const counts = [',', ';', '\t'].map((candidate) => ({
    candidate,
    count: header.split(candidate).length,
  }))
  counts.sort((a, b) => b.count - a.count)
  return counts[0] && counts[0].count > 1 ? counts[0].candidate : ','
}

/** Строки CSV по RFC 4180: кавычки, удвоенная кавычка внутри, переводы строк в поле. */
function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Записи CSV: первая строка — имена столбцов, пустые строки пропускаются. */
export function parseCsv(text: string): FeedRecord[] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/))
  const rows = csvRows(text, delimiterOf(firstLine))
  const [header, ...body] = rows
  if (!header) return []
  const names = header.map((name, index) => name.trim() || `column_${index + 1}`)
  return body
    .filter((row) => !(row.length === 1 && row[0]?.trim() === ''))
    .map((row) => Object.fromEntries(names.map((name, index) => [name, row[index] ?? ''])))
}

/**
 * Записи ленты по формату: объекты GeoJSON (`FeatureCollection` или один
 * `Feature`), элементы массива JSON (по пути или в корне), строки CSV. Не тот
 * формат — `dependency_failed` с понятной причиной.
 */
export function parseFeed(
  body: Buffer | string,
  format: FeedFormat,
  itemsPath: string | null,
): FeedRecord[] {
  const text = (typeof body === 'string' ? body : body.toString('utf8')).replace(/^﻿/, '')
  if (format === 'csv') {
    if (/^\s*[[{<]/.test(text)) {
      throw errors.dependencyFailed('Ответ ленты — не CSV: похоже на JSON или HTML')
    }
    return parseCsv(text)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw errors.dependencyFailed('Ответ ленты — не JSON')
  }
  if (format === 'geojson') {
    if (isObject(parsed) && parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      return parsed.features.filter(isObject)
    }
    if (isObject(parsed) && parsed.type === 'Feature') return [parsed]
    throw errors.dependencyFailed('Ответ ленты — не GeoJSON: нет коллекции объектов')
  }
  const items = itemsPath ? valueAt(parsed, itemsPath) : parsed
  if (!Array.isArray(items)) {
    throw errors.dependencyFailed(
      itemsPath
        ? `В ответе ленты по пути «${itemsPath}» нет массива записей`
        : 'Ответ ленты — не массив записей: укажите путь к массиву',
    )
  }
  return items.filter(isObject)
}

// ── Геометрия ───────────────────────────────────────────────────────────────

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
])

/** Глубина вложенности массивов координат у каждого типа. */
const COORDINATE_DEPTH: Record<string, number> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Number(value.trim().replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

/** Позиция в двумерную: высота и глубина (у USGS — третья координата) отбрасываются. */
function position(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const lon = toNumber(value[0])
  const lat = toNumber(value[1])
  if (lon === null || lat === null || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null
  return [lon, lat]
}

function coordinatesOf(value: unknown, depth: number): unknown {
  if (depth === 0) return position(value)
  if (!Array.isArray(value) || value.length === 0) return null
  const items = value.map((item) => coordinatesOf(item, depth - 1))
  return items.some((item) => item === null) ? null : items
}

/**
 * Геометрия GeoJSON, приведённая к двумерной: тип из перечня, координаты в
 * пределах WGS 84; иначе null. Набор геометрий не поддерживается.
 */
export function normalizeGeometry(value: unknown): FeedGeometryValue | null {
  if (!isObject(value) || typeof value.type !== 'string' || !GEOMETRY_TYPES.has(value.type)) {
    return null
  }
  const coordinates = coordinatesOf(value.coordinates, COORDINATE_DEPTH[value.type] ?? 0)
  return coordinates === null ? null : { type: value.type, coordinates }
}

/** Геометрия записи по настройке ленты: объект GeoJSON или точка из широты и долготы. */
export function recordGeometry(
  record: FeedRecord,
  spec: FeedGeometry | null,
): FeedGeometryValue | null {
  if (!spec) return null
  if (spec.kind === 'feature') return normalizeGeometry(record.geometry)
  const point = position([valueAt(record, spec.lon), valueAt(record, spec.lat)])
  return point ? { type: 'Point', coordinates: point } : null
}

function collectPositions(value: unknown, into: Array<[number, number]>): void {
  if (!Array.isArray(value)) return
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    into.push([value[0], value[1]])
    return
  }
  for (const item of value) collectPositions(item, into)
}

/** Охват геометрии: запад, юг, восток, север. */
export function geometryBbox(geometry: FeedGeometryValue): FeedBbox | null {
  const positions: Array<[number, number]> = []
  collectPositions(geometry.coordinates, positions)
  if (positions.length === 0) return null
  let [west, south] = positions[0] as [number, number]
  let [east, north] = [west, south]
  for (const [lon, lat] of positions) {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [west, south, east, north]
}

/** Геометрия задевает область отбора (охваты пересекаются). */
export function withinBbox(geometry: FeedGeometryValue, area: FeedBbox): boolean {
  const box = geometryBbox(geometry)
  if (!box) return false
  return box[0] <= area[2] && box[2] >= area[0] && box[1] <= area[3] && box[3] >= area[1]
}

// ── Значения ────────────────────────────────────────────────────────────────

const NUMERIC = new Set(['integer', 'number', 'decimal', 'money', 'percent'])
const TEXTUAL = new Set([
  'text',
  'long_text',
  'identifier',
  'select',
  'url',
  'email',
  'phone',
  'territory',
  'user',
  'unit',
  'object_ref',
  'file',
])
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'да', 'истина'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'нет', 'ложь'])

/** Дата-время ISO без пояса считается всемирным временем: ленты публикуют UTC. */
const ISO_LIKE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/i

function isoFromEpoch(value: number, unit: 'ms' | 's' | 'auto'): string | null {
  const ms = unit === 's' || (unit === 'auto' && Math.abs(value) < 1e11) ? value * 1000 : value
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Момент времени ISO 8601 с поясом; не разобрать — null. */
export function isoDateTime(value: unknown): string | null {
  if (typeof value === 'number') return isoFromEpoch(value, 'auto')
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim()
  const match = ISO_LIKE.exec(text)
  if (match) {
    const [, date, time, zone] = match
    const normalizedZone = zone ? (zone.toUpperCase() === 'Z' ? 'Z' : zone) : 'Z'
    const parsed = new Date(`${date}T${time ?? '00:00:00'}${normalizedZone}`)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return isoFromEpoch(Number(text), 'auto')
  // RFC 2822 и прочие записи, которые понимает Date (например, pubDate RSS)
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/** Дата и время в двух полях, всемирное время: `2026-09-23` + `0517` / `5:17` / `517`. */
export function dateTimeOf(date: unknown, time: unknown): string | null {
  const day = typeof date === 'string' ? date.trim().slice(0, 10) : null
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const raw = typeof time === 'number' ? String(time) : typeof time === 'string' ? time.trim() : ''
  const digits = raw.replace(':', '')
  if (!/^\d{1,4}$/.test(digits)) return null
  const padded = digits.padStart(4, '0')
  const parsed = new Date(`${day}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Значение записи в тип поля датасета. Пустая строка ленты — «нет значения». Не
 * удалось привести — значение остаётся как было: проверка строки при записи
 * назовёт поле и причину.
 */
export function coerceValue(
  raw: unknown,
  transform: FeedTransform,
  type: StoredFieldType,
): unknown {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  if (transform === 'text') return text(raw)
  if (transform === 'number') return byType(toNumber(raw) ?? raw, type)
  if (transform === 'epoch_ms' || transform === 'epoch_s') {
    const number = toNumber(raw)
    const iso = number === null ? null : isoFromEpoch(number, transform === 'epoch_ms' ? 'ms' : 's')
    return byType(iso ?? raw, type)
  }
  return byType(raw, type)
}

/** Приведение по типу поля датасета (`auto`). */
function byType(raw: unknown, type: StoredFieldType): unknown {
  if (type === 'datetime') return isoDateTime(raw) ?? raw
  if (type === 'date') {
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.trim())) {
      return raw.trim().slice(0, 10)
    }
    const iso = isoDateTime(raw)
    return iso ? iso.slice(0, 10) : raw
  }
  if (NUMERIC.has(type)) return toNumber(raw) ?? raw
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    const word = text(raw).trim().toLowerCase()
    if (TRUE_WORDS.has(word)) return true
    if (FALSE_WORDS.has(word)) return false
    return raw
  }
  if (type === 'geometry') return normalizeGeometry(raw) ?? raw
  if (type === 'multi_select') {
    if (Array.isArray(raw)) return raw.map(text)
    return text(raw)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  if (type === 'json') return raw
  if (TEXTUAL.has(type)) return text(raw)
  return raw
}

/** Шаблон `{путь}` из полей записи; нет значения — пустая строка на его месте. */
export function renderRecordTemplate(template: string, record: FeedRecord): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, path: string) => {
    const value = valueAt(record, path.trim())
    return value === undefined || value === null ? '' : text(value)
  })
}

/** Значение поля датасета по его сопоставлению с записью ленты. */
export function mappedValue(record: FeedRecord, value: FeedValue, type: StoredFieldType): unknown {
  switch (value.kind) {
    case 'const':
      return coerceValue(value.value, 'auto', type)
    case 'template': {
      const rendered = renderRecordTemplate(value.template, record).trim()
      return rendered === '' ? null : coerceValue(rendered, 'auto', type)
    }
    case 'date_time':
      return dateTimeOf(valueAt(record, value.date), valueAt(record, value.time))
    default:
      return coerceValue(valueAt(record, value.path), value.transform, type)
  }
}

/**
 * Текст значения ключа для сопоставления со строками датасета (`::text` столбца):
 * пусто — у записи нет ключа, и она пропускается.
 */
export function keyText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const result = typeof value === 'string' ? value.trim() : text(value)
  return result === '' ? null : result
}

// ── Предпросмотр ─────────────────────────────────────────────────────────────

const MAX_DEPTH = 5
/** Короткие массивы значений раскладываются по номерам (`coordinates.0`), длинные — целиком. */
const SHORT_ARRAY = 6

/** Запись в пары «путь → значение»: геометрия GeoJSON — одним значением. */
export function flattenRecord(record: unknown, prefix = '', depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const visit = (value: unknown, path: string, level: number) => {
    if (path && normalizeGeometry(value)) {
      out[path] = value
      return
    }
    if (Array.isArray(value)) {
      const primitives = value.every((item) => item === null || typeof item !== 'object')
      if (level >= MAX_DEPTH || (primitives && value.length > SHORT_ARRAY)) {
        if (path) out[path] = value
        return
      }
      if (primitives) {
        value.forEach((item, index) => {
          out[path ? `${path}.${index}` : String(index)] = item
        })
        return
      }
      // Массив объектов — по первому элементу: пути у элементов обычно одни
      if (value.length > 0) visit(value[0], path ? `${path}.0` : '0', level + 1)
      return
    }
    if (isObject(value)) {
      if (level >= MAX_DEPTH) {
        if (path) out[path] = value
        return
      }
      for (const [key, item] of Object.entries(value)) {
        if (UNSAFE.has(key)) continue
        visit(item, path ? `${path}.${key}` : key, level + 1)
      }
      return
    }
    if (path) out[path] = value
  }
  visit(record, prefix, depth)
  return out
}

function valueType(path: string, value: unknown): FeedValueType {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') {
    // Миллисекунды эпохи в поле времени (USGS `time`, `updated`)
    const timeName = /(time|date|updated|created)$/i.test(path.split('.').at(-1) ?? '')
    return timeName && Math.abs(value) >= 1e11 && Math.abs(value) < 1e14 ? 'datetime' : 'number'
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (ISO_LIKE.test(trimmed) && /^\d{4}-\d{2}-\d{2}/.test(trimmed)) return 'datetime'
    if (trimmed !== '' && /^-?\d+([.,]\d+)?$/.test(trimmed)) return 'number'
    return 'text'
  }
  if (normalizeGeometry(value)) return 'geometry'
  return 'object'
}

/** Пути записей ленты с типом, примером и заполненностью — для сопоставления полей. */
export function discoverPaths(records: readonly FeedRecord[]): FeedPathInfo[] {
  const seen = new Map<
    string,
    { types: Map<FeedValueType, number>; sample: unknown; filled: number }
  >()
  for (const record of records) {
    for (const [path, value] of Object.entries(flattenRecord(record))) {
      let entry = seen.get(path)
      if (!entry) {
        entry = { types: new Map(), sample: null, filled: 0 }
        seen.set(path, entry)
      }
      if (value === null || value === undefined || value === '') continue
      entry.filled += 1
      if (entry.sample === null) entry.sample = value
      const type = valueType(path, value)
      entry.types.set(type, (entry.types.get(type) ?? 0) + 1)
    }
  }
  return [...seen.entries()].map(([path, entry]) => {
    const [type] = [...entry.types.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['text']
    return { path, type, sample: entry.sample, filled: entry.filled }
  })
}
