/**
 * Сборка CAP 1.2, индекса Atom и RSS (ADR-0202) — чистые функции без доступа к
 * базе. Каждое значение проходит экранирование XML; символы, недопустимые в
 * XML 1.0 (управляющие, одиночные суррогаты), выбрасываются: документ остаётся
 * правильным, что бы ни ввёл автор. Порядок элементов — по схеме OASIS
 * `CAP-v1.2.xsd`: валидаторы и агрегаторы проверяют его строго.
 */

export const CAP_NAMESPACE = 'urn:oasis:names:tc:emergency:cap:1.2'

/** Символы вне XML 1.0 — прочь; переводы строк и табуляция остаются. */
function allowedInXml(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  )
}

/** Строка без символов вне XML 1.0 (одиночный суррогат — тоже прочь). */
function withoutInvalid(value: string): string {
  let out = ''
  for (const char of value) {
    if (allowedInXml(char.codePointAt(0) ?? 0)) out += char
  }
  return out
}

/** Текст для содержимого элемента и значения атрибута в двойных кавычках. */
export function xmlText(value: string): string {
  return withoutInvalid(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Элемент с текстом; пустое значение — элемента нет (необязательные поля CAP). */
function element(name: string, value: string | null | undefined, indent: string): string {
  if (value === null || value === undefined || value === '') return ''
  return `${indent}<${name}>${xmlText(value)}</${name}>\n`
}

/** Смещение пояса в момент времени: `+05:00`. */
function offsetOf(date: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name ?? '')
  if (!match) return '+00:00'
  return `${match[1]}:${match[2] ?? '00'}`
}

/**
 * Время CAP: `2026-10-12T18:00:00+05:00` — секунды без долей, смещение явно
 * (шаблон схемы не принимает `Z`), по поясу установки.
 */
export function capDateTime(value: Date | string, timeZone: string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetOf(date, timeZone)}`
}

/** Кольцо `[lon, lat]` → `lat,lon lat,lon …`, замкнутое (CAP: первая точка = последней). */
export function capPolygon(ring: ReadonlyArray<readonly [number, number]>): string | null {
  const points = ring.map(([lon, lat]) => [round(lat), round(lon)] as const)
  if (points.length < 3) return null
  const first = points[0] as readonly [number, number]
  const last = points.at(-1) as readonly [number, number]
  if (first[0] !== last[0] || first[1] !== last[1]) points.push(first)
  if (points.length < 4) return null
  return points.map(([lat, lon]) => `${lat},${lon}`).join(' ')
}

const round = (value: number) => Math.round(value * 1e5) / 1e5

export interface CapArea {
  areaDesc: string
  polygons: string[]
  geocodes: Array<{ valueName: string; value: string }>
}

export interface CapInfo {
  /** RFC 3066: `tg-TJ`, `ru-RU`, `en-US`. */
  language: string
  categories: readonly string[]
  event: string
  responseTypes: readonly string[]
  urgency: string
  severity: string
  certainty: string
  effective: string | null
  expires: string | null
  senderName: string
  headline: string
  description: string
  instruction: string
  web: string | null
  areas: readonly CapArea[]
}

export interface CapAlert {
  identifier: string
  sender: string
  sent: string
  status: string
  msgType: string
  /** `sender,identifier,sent` прежних сообщений через пробел. */
  references: string | null
  infos: readonly CapInfo[]
}

function renderArea(area: CapArea): string {
  const indent = '      '
  let out = '    <area>\n'
  out += element('areaDesc', area.areaDesc, indent)
  for (const polygon of area.polygons) out += element('polygon', polygon, indent)
  for (const code of area.geocodes) {
    out += `${indent}<geocode>\n`
    out += element('valueName', code.valueName, `${indent}  `)
    out += element('value', code.value, `${indent}  `)
    out += `${indent}</geocode>\n`
  }
  return `${out}    </area>\n`
}

function renderInfo(info: CapInfo): string {
  const indent = '    '
  let out = '  <info>\n'
  out += element('language', info.language, indent)
  for (const category of info.categories) out += element('category', category, indent)
  out += element('event', info.event, indent)
  for (const type of info.responseTypes) out += element('responseType', type, indent)
  out += element('urgency', info.urgency, indent)
  out += element('severity', info.severity, indent)
  out += element('certainty', info.certainty, indent)
  out += element('effective', info.effective, indent)
  out += element('expires', info.expires, indent)
  out += element('senderName', info.senderName, indent)
  out += element('headline', info.headline, indent)
  out += element('description', info.description, indent)
  out += element('instruction', info.instruction, indent)
  out += element('web', info.web, indent)
  for (const area of info.areas) out += renderArea(area)
  return `${out}  </info>\n`
}

/** Документ CAP 1.2: один `alert`, блоки `info` по языкам. */
export function renderCapAlert(alert: CapAlert): string {
  const indent = '  '
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
  out += `<alert xmlns="${CAP_NAMESPACE}">\n`
  out += element('identifier', alert.identifier, indent)
  out += element('sender', alert.sender, indent)
  out += element('sent', alert.sent, indent)
  out += element('status', alert.status, indent)
  out += element('msgType', alert.msgType, indent)
  out += element('scope', 'Public', indent)
  out += element('references', alert.references, indent)
  for (const info of alert.infos) out += renderInfo(info)
  return `${out}</alert>\n`
}

export interface FeedEntry {
  identifier: string
  title: string
  summary: string
  /** RFC 3339 — для Atom; RSS получает RFC 822 из того же момента. */
  sent: Date
  capUrl: string
}

/**
 * Индекс Atom опубликованных (как ленты CAP национальных служб в WMO Register
 * of Alerting Authorities): запись — заголовок, кратко и ссылка на CAP.
 */
export function renderAtomFeed(input: {
  id: string
  title: string
  selfUrl: string
  updated: Date
  author: string
  language: string
  entries: readonly FeedEntry[]
}): string {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
  out += `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlText(input.language)}">\n`
  out += element('id', input.id, '  ')
  out += element('title', input.title, '  ')
  out += element('updated', input.updated.toISOString(), '  ')
  out += `  <link rel="self" type="application/atom+xml" href="${xmlText(input.selfUrl)}"/>\n`
  out += `  <author>\n${element('name', input.author, '    ')}  </author>\n`
  for (const entry of input.entries) {
    out += '  <entry>\n'
    out += element('id', entry.identifier, '    ')
    out += element('title', entry.title, '    ')
    out += element('updated', entry.sent.toISOString(), '    ')
    out += element('summary', entry.summary, '    ')
    out += `    <link rel="alternate" type="application/cap+xml" href="${xmlText(entry.capUrl)}"/>\n`
    out += '  </entry>\n'
  }
  return `${out}</feed>\n`
}

/** RSS 2.0 одного языка: заголовок и описание — из блока `info` этого языка. */
export function renderRssFeed(input: {
  title: string
  link: string
  description: string
  language: string
  entries: readonly FeedEntry[]
}): string {
  let out = '<?xml version="1.0" encoding="UTF-8"?>\n'
  out += '<rss version="2.0">\n  <channel>\n'
  out += element('title', input.title, '    ')
  out += element('link', input.link, '    ')
  out += element('description', input.description, '    ')
  out += element('language', input.language, '    ')
  for (const entry of input.entries) {
    out += '    <item>\n'
    out += element('title', entry.title, '      ')
    out += element('description', entry.summary, '      ')
    out += element('link', entry.capUrl, '      ')
    out += `      <guid isPermaLink="false">${xmlText(entry.identifier)}</guid>\n`
    out += element('pubDate', entry.sent.toUTCString(), '      ')
    out += '    </item>\n'
  }
  return `${out}  </channel>\n</rss>\n`
}
