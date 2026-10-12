import { errors } from '~/shared/errors.js'
import {
  childNamed,
  childrenNamed,
  childText,
  descendantsNamed,
  parseXml,
  textOf,
  type XmlElement,
  XmlError,
} from '~/shared/xml.js'

/** Запись ленты — как у `feed-parse.ts` (без импорта: разборщик форматов зовёт этот файл). */
type FeedRecord = Record<string, unknown>

/** Геометрия GeoJSON записи, двумерная, WGS 84. */
interface FeedGeometryValue {
  type: string
  coordinates: unknown
}

/**
 * Лента CAP 1.2 (Common Alerting Protocol, Рекомендация МСЭ-Т X.1303; ADR-0201) —
 * чистые функции разбора без сети. Документ ленты — само сообщение `<alert>` или
 * индекс Atom/RSS: сообщения внутри записей индекса (так публикует GDACS) или
 * ссылки на них (их забирает сервис ленты). Сообщение становится записью ленты
 * с плоскими путями для сопоставления полей: `info.headline`,
 * `info.parameter.alertlevel`, `area.desc`, `lang.ru.headline`, `geometry`.
 */

/**
 * Порядок выбора блока `info`, когда их несколько на разных языках: русский —
 * основной язык интерфейса и сводок, затем таджикский, затем английский, иначе
 * первый блок. Остальные блоки доступны по пути `lang.<код>.<поле>`.
 */
export const CAP_LANGUAGES = ['ru', 'tg', 'en'] as const

/**
 * Сообщения, которые получателю не адресованы (п. 3.2.1 стандарта): технический
 * тест, черновик и служебные сообщения сети; подтверждение и ошибка (`Ack`,
 * `Error`) ничего не сообщают об опасном явлении. «Учение» (`Exercise`)
 * принимается — по нему проводят учения дежурной смены.
 */
const SKIPPED_STATUS = new Set(['Test', 'Draft', 'System'])
const SKIPPED_TYPES = new Set(['Ack', 'Error'])

/** Ключи, которые нельзя заводить в объекте записи: прототип объекта. */
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])

/** Сколько вершин у многоугольника, которым приближается круг области. */
const CIRCLE_VERTICES = 36

export interface CapDocument {
  /** Сообщения документа — само сообщение или встроенные в индекс. */
  alerts: FeedRecord[]
  /** Ссылки индекса на сообщения, которых нет внутри индекса (абсолютные адреса). */
  links: string[]
  /** Сообщения, не адресованные получателю: тест, черновик, служебные. */
  skipped: number
}

const toNumber = (value: string): number | null => {
  const parsed = Number(value.trim())
  return value.trim() !== '' && Number.isFinite(parsed) ? parsed : null
}

/** Пара `valueName`/`value` (eventCode, parameter, geocode) в объект; повтор — через запятую. */
function namedValues(elements: XmlElement[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const element of elements) {
    const name = childText(element, 'valueName')
    if (!name || UNSAFE.has(name)) continue
    const value = childText(element, 'value')
    out[name] = Object.hasOwn(out, name) && out[name] ? `${out[name]},${value}` : value
  }
  return out
}

/** Позиция CAP «широта,долгота» → [долгота, широта] GeoJSON; вне WGS 84 — null. */
function position(pair: string): [number, number] | null {
  const [lat, lon] = pair.split(',').map((part) => toNumber(part))
  if (lat === null || lat === undefined || lon === null || lon === undefined) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return [lon, lat]
}

/** Многоугольник CAP: пары через пробел, первая равна последней (замкнём, если нет). */
function polygonRing(text: string): Array<[number, number]> | null {
  const points = text.trim().split(/\s+/).filter(Boolean).map(position)
  if (points.some((point) => point === null)) return null
  const ring = points as Array<[number, number]>
  if (ring.length < 3) return null
  const [first] = ring
  const last = ring[ring.length - 1] as [number, number]
  if (first && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]])
  return ring.length >= 4 ? ring : null
}

/** Круг CAP «широта,долгота радиус_км»: многоугольник, нулевой радиус — точка. */
function circle(
  text: string,
): { point: [number, number] } | { ring: Array<[number, number]> } | null {
  const [center, radiusText] = text.trim().split(/\s+/)
  const at = center ? position(center) : null
  const radius = radiusText ? toNumber(radiusText) : null
  if (!at || radius === null || radius < 0) return null
  if (radius === 0) return { point: at }
  const [lon, lat] = at
  // Сферическое приближение: градус широты ≈ 111,32 км, долготы — с поправкой на широту
  const dLat = radius / 111.32
  const dLon = radius / (111.32 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01))
  const ring: Array<[number, number]> = []
  for (let index = 0; index < CIRCLE_VERTICES; index++) {
    const angle = (2 * Math.PI * index) / CIRCLE_VERTICES
    const x = Math.max(-180, Math.min(180, lon + dLon * Math.cos(angle)))
    const y = Math.max(-90, Math.min(90, lat + dLat * Math.sin(angle)))
    ring.push([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6])
  }
  ring.push([...(ring[0] as [number, number])])
  return { ring }
}

/**
 * Геометрия областей сообщения: многоугольники и круги — `Polygon` или
 * `MultiPolygon`; только точки (круг нулевого радиуса) — `Point` или `MultiPoint`;
 * у области только геокоды — геометрии нет.
 */
export function capGeometry(areas: XmlElement[]): FeedGeometryValue | null {
  const polygons: Array<Array<Array<[number, number]>>> = []
  const points: Array<[number, number]> = []
  for (const area of areas) {
    for (const element of childrenNamed(area, 'polygon')) {
      const ring = polygonRing(textOf(element))
      if (ring) polygons.push([ring])
    }
    for (const element of childrenNamed(area, 'circle')) {
      const shape = circle(textOf(element))
      if (!shape) continue
      if ('ring' in shape) polygons.push([shape.ring])
      else points.push(shape.point)
    }
  }
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] }
  if (polygons.length > 1) return { type: 'MultiPolygon', coordinates: polygons }
  if (points.length === 1) return { type: 'Point', coordinates: points[0] }
  if (points.length > 1) return { type: 'MultiPoint', coordinates: points }
  return null
}

/** Поля блока `info` — плоский объект для сопоставления. */
function infoRecord(info: XmlElement): Record<string, unknown> {
  const joined = (name: string) =>
    childrenNamed(info, name)
      .map((element) => textOf(element))
      .filter(Boolean)
      .join(', ')
  const areas = childrenNamed(info, 'area')
  return {
    language: childText(info, 'language') || 'en-US',
    category: joined('category'),
    event: childText(info, 'event'),
    responseType: joined('responseType'),
    urgency: childText(info, 'urgency'),
    severity: childText(info, 'severity'),
    certainty: childText(info, 'certainty'),
    audience: childText(info, 'audience'),
    eventCode: namedValues(childrenNamed(info, 'eventCode')),
    effective: childText(info, 'effective'),
    onset: childText(info, 'onset'),
    expires: childText(info, 'expires'),
    senderName: childText(info, 'senderName'),
    headline: childText(info, 'headline'),
    description: childText(info, 'description'),
    instruction: childText(info, 'instruction'),
    web: childText(info, 'web'),
    contact: childText(info, 'contact'),
    parameter: namedValues(childrenNamed(info, 'parameter')),
    area: {
      desc: areas
        .map((area) => childText(area, 'areaDesc'))
        .filter(Boolean)
        .join('; '),
      geocode: namedValues(areas.flatMap((area) => childrenNamed(area, 'geocode'))),
    },
  }
}

/** Первичный подтег языка: `ru-TJ` → `ru`. */
const primaryLanguage = (tag: string) => tag.trim().toLowerCase().split('-')[0] ?? ''

/** Блок `info` по порядку языков `CAP_LANGUAGES`, иначе первый. */
function preferredInfo(infos: XmlElement[]): XmlElement | null {
  for (const language of CAP_LANGUAGES) {
    const found = infos.find(
      (info) => primaryLanguage(childText(info, 'language') || 'en-US') === language,
    )
    if (found) return found
  }
  return infos[0] ?? null
}

export interface CapReference {
  sender: string
  identifier: string
  sent: string
}

/** `references`: «отправитель,идентификатор,время» через пробел. */
export function capReferences(text: string): CapReference[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((item) => item.split(','))
    .filter((parts) => parts.length === 3 && parts.every((part) => part.trim() !== ''))
    .map(([sender, identifier, sent]) => ({
      sender: sender as string,
      identifier: identifier as string,
      sent: sent as string,
    }))
}

/**
 * Ключ нити сообщений «идентификатор,время отправки»: у первичного сообщения —
 * свой, у уточнения и отмены (`Update`, `Cancel`) — самого раннего из сообщений,
 * на которые оно ссылается. Так все сообщения об одном явлении пишутся в одну
 * строку датасета, а не плодят новые.
 */
export function capThreadKey(identifier: string, sent: string, references: CapReference[]): string {
  if (references.length === 0) return `${identifier},${sent}`
  const time = (value: string) => {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
  }
  const root = [...references].sort((a, b) => time(a.sent) - time(b.sent))[0] as CapReference
  return `${root.identifier},${root.sent}`
}

/**
 * Сообщение `<alert>` → запись ленты; сообщение не для получателя (тест,
 * черновик, служебное, подтверждение, ошибка) — null.
 */
export function capAlertRecord(alert: XmlElement): FeedRecord | null {
  const status = childText(alert, 'status')
  const msgType = childText(alert, 'msgType')
  if (SKIPPED_STATUS.has(status) || SKIPPED_TYPES.has(msgType)) return null
  const identifier = childText(alert, 'identifier')
  const sent = childText(alert, 'sent')
  if (!identifier || !sent) return null
  const referencesText = childText(alert, 'references')
  const references = capReferences(referencesText)
  const infos = childrenNamed(alert, 'info')
  const preferred = preferredInfo(infos)
  const lang: Record<string, unknown> = {}
  for (const info of infos) {
    const code = primaryLanguage(childText(info, 'language') || 'en-US')
    if (code && !UNSAFE.has(code) && !Object.hasOwn(lang, code)) lang[code] = infoRecord(info)
  }
  const info = preferred ? infoRecord(preferred) : {}
  // Геометрия — областей выбранного блока; без них — любого блока с областями
  const withAreas =
    preferred && childrenNamed(preferred, 'area').length > 0
      ? preferred
      : infos.find((item) => childrenNamed(item, 'area').length > 0)
  return {
    key: capThreadKey(identifier, sent, references),
    identifier,
    sender: childText(alert, 'sender'),
    sent,
    status,
    msgType,
    source: childText(alert, 'source'),
    scope: childText(alert, 'scope'),
    restriction: childText(alert, 'restriction'),
    code: childrenNamed(alert, 'code')
      .map((element) => textOf(element))
      .filter(Boolean)
      .join(', '),
    note: childText(alert, 'note'),
    references: referencesText,
    incidents: childText(alert, 'incidents'),
    language: (info as { language?: string }).language ?? '',
    info,
    area: (info as { area?: unknown }).area ?? { desc: '', geocode: {} },
    lang,
    geometry: withAreas ? capGeometry(childrenNamed(withAreas, 'area')) : null,
  }
}

/** Ссылка записи индекса на сообщение: по типу CAP/XML, затем «alternate», затем первая. */
function entryLink(entry: XmlElement): string | null {
  const links = childrenNamed(entry, 'link')
    .map((link) => ({
      href: link.attributes.href ?? textOf(link),
      rel: link.attributes.rel ?? 'alternate',
      type: link.attributes.type ?? '',
    }))
    .filter((link) => link.href && link.rel !== 'self')
  const typed = links.find((link) => /cap|xml/i.test(link.type))
  const alternate = links.find((link) => link.rel === 'alternate')
  return (typed ?? alternate ?? links[0])?.href ?? null
}

/** Ссылка элемента RSS: вложение CAP/XML, иначе `link`. */
function itemLink(item: XmlElement): string | null {
  const enclosure = childrenNamed(item, 'enclosure').find((element) =>
    /cap|xml/i.test(element.attributes.type ?? ''),
  )
  return enclosure?.attributes.url ?? (childText(item, 'link') || null)
}

/** Абсолютный адрес http(s) относительно адреса ленты; иное — null. */
function absolute(link: string, base: string | null): string | null {
  try {
    const url = base ? new URL(link, base) : new URL(link)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function parseDocument(body: Buffer | string): XmlElement {
  const text = typeof body === 'string' ? body : body.toString('utf8')
  try {
    return parseXml(text)
  } catch (error) {
    const reason = error instanceof XmlError ? error.message : 'документ не разбирается'
    throw errors.dependencyFailed(`Ответ ленты — не XML: ${reason}`)
  }
}

/**
 * Документ ленты CAP: сообщение `<alert>` или индекс Atom (`<feed>`) и RSS
 * (`<rss>`). У записи индекса сообщение внутри — берётся оно, иначе ссылка.
 */
export function parseCapDocument(body: Buffer | string, baseUrl: string | null): CapDocument {
  const root = parseDocument(body)
  const result: CapDocument = { alerts: [], links: [], skipped: 0 }
  const take = (alert: XmlElement) => {
    const record = capAlertRecord(alert)
    if (record) result.alerts.push(record)
    else result.skipped += 1
  }
  if (root.name === 'alert') {
    take(root)
    return result
  }
  let entries: XmlElement[]
  let linkOf: (entry: XmlElement) => string | null
  if (root.name === 'feed') {
    entries = childrenNamed(root, 'entry')
    linkOf = entryLink
  } else if (root.name === 'rss' || root.name === 'RDF') {
    const channel = childNamed(root, 'channel')
    entries = [...(channel ? childrenNamed(channel, 'item') : []), ...childrenNamed(root, 'item')]
    linkOf = itemLink
  } else {
    throw errors.dependencyFailed(
      `Ответ ленты — не CAP: ожидалось сообщение <alert> или индекс Atom/RSS, получено <${root.name}>`,
    )
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    const inline = descendantsNamed(entry, 'alert')
    if (inline.length > 0) {
      for (const alert of inline) take(alert)
      continue
    }
    const raw = linkOf(entry)
    const url = raw ? absolute(raw, baseUrl) : null
    if (url && !seen.has(url)) {
      seen.add(url)
      result.links.push(url)
    }
  }
  return result
}

/**
 * Записи по времени отправки, от ранних к поздним: при повторе ключа нити в одном
 * ответе остаётся последняя запись (`prepare` сервиса ленты), то есть самое
 * свежее уточнение или отмена.
 */
export function orderCapRecords(records: FeedRecord[]): FeedRecord[] {
  const time = (record: FeedRecord) => {
    const parsed = Date.parse(String(record.sent ?? ''))
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return [...records].sort((a, b) => time(a) - time(b))
}
