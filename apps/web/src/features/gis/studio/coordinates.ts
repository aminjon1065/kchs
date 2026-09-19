/**
 * Координаты для поиска и строки под курсором (P2-E02 S02, ADR-0073): разбор
 * десятичных градусов и градусов-минут-секунд, вывод в двух форматах.
 */

export interface LonLat {
  lon: number
  lat: number
}

/** Вариант прочтения строки: полушария заданы явно или порядок чисел. */
export interface CoordinateCandidate extends LonLat {
  order: 'hemisphere' | 'latlon' | 'lonlat'
}

type Hemisphere = 'n' | 's' | 'e' | 'w'

type Token =
  | { kind: 'num'; value: number; negative: boolean; mark: 'deg' | 'min' | 'sec' | null }
  | { kind: 'hem'; value: Hemisphere }
  | { kind: 'sep' }

/** Полушария словами: «с. ш.», «в. д.», «N», «E»… — в одну букву. */
const HEMISPHERE_WORDS: Array<[RegExp, Hemisphere]> = [
  [/с\.?\s*ш\.?/g, 'n'],
  [/ю\.?\s*ш\.?/g, 's'],
  [/в\.?\s*д\.?/g, 'e'],
  [/з\.?\s*д\.?/g, 'w'],
  [/\bnorth\b/g, 'n'],
  [/\bsouth\b/g, 's'],
  [/\beast\b/g, 'e'],
  [/\bwest\b/g, 'w'],
]

function normalize(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″”“]/g, '"')
    .replace(/''/g, '"')
    .replace(/[º˚]/g, '°')
    .replace(/[−–—]/g, '-')
    .trim()
  for (const [pattern, letter] of HEMISPHERE_WORDS) s = s.replace(pattern, ` ${letter} `)
  // Десятичная запятая: «38,56 68,78» и «38,5; 68,7» — если нет точек и пара разделена иначе
  if (!s.includes('.') && /\d,\d/.test(s) && (s.includes(';') || /\d,\d+\s+-?\d/.test(s))) {
    s = s.replace(/(\d),(\d)/g, '$1.$2')
  }
  return s
}

function tokenize(s: string): Token[] | null {
  const tokens: Token[] = []
  const pattern = /\s*(?:(-?\d+(?:\.\d+)?)\s*([°'"])?|([nsew])(?![a-zа-я])|([;,]))/y
  let at = 0
  while (at < s.length) {
    pattern.lastIndex = at
    const match = pattern.exec(s)
    if (!match) {
      if (/^\s*$/.test(s.slice(at))) break
      return null
    }
    at = pattern.lastIndex
    if (match[1] !== undefined) {
      const mark = match[2] === '°' ? 'deg' : match[2] === "'" ? 'min' : match[2] ? 'sec' : null
      tokens.push({
        kind: 'num',
        value: Math.abs(Number(match[1])),
        negative: match[1].startsWith('-'),
        mark,
      })
    } else if (match[3]) {
      tokens.push({ kind: 'hem', value: match[3] as Hemisphere })
    } else {
      tokens.push({ kind: 'sep' })
    }
  }
  return tokens
}

type NumToken = Extract<Token, { kind: 'num' }>

interface Part {
  numbers: NumToken[]
  hemisphere: Hemisphere | null
}

/** Две части координаты: по разделителю, по буквам полушарий или по числу значений. */
function split(tokens: Token[]): Part[] | null {
  const seps = tokens.filter((token) => token.kind === 'sep').length
  const groups: Token[][] = []
  if (seps === 1) {
    const index = tokens.findIndex((token) => token.kind === 'sep')
    groups.push(tokens.slice(0, index), tokens.slice(index + 1))
  } else if (seps > 1) {
    return null
  } else if (tokens.some((token) => token.kind === 'hem')) {
    // Буква после чисел («38.5n 68.7e») или перед ними («n38.5 e68.7»)
    const leading = tokens[0]?.kind === 'hem'
    let current: Token[] = []
    for (const token of tokens) {
      if (token.kind === 'hem' && leading && current.length > 0) {
        groups.push(current)
        current = []
      }
      current.push(token)
      if (token.kind === 'hem' && !leading) {
        groups.push(current)
        current = []
      }
    }
    if (current.length > 0) groups.push(current)
  } else {
    const numbers = tokens as NumToken[]
    const degrees = numbers.filter((token) => token.mark === 'deg').length
    if (degrees === 2) {
      // Каждая часть начинается с градусов
      let current: Token[] = []
      for (const token of numbers) {
        if (token.mark === 'deg' && current.length > 0) {
          groups.push(current)
          current = []
        }
        current.push(token)
      }
      groups.push(current)
    } else if (numbers.length === 2 || numbers.length === 4 || numbers.length === 6) {
      const half = numbers.length / 2
      groups.push(numbers.slice(0, half), numbers.slice(half))
    } else {
      return null
    }
  }
  if (groups.length !== 2) return null
  const parts: Part[] = []
  for (const group of groups) {
    const numbers = group.filter((token): token is NumToken => token.kind === 'num')
    const hems = group.filter((token) => token.kind === 'hem')
    if (numbers.length === 0 || numbers.length > 3 || hems.length > 1) return null
    parts.push({ numbers, hemisphere: hems[0]?.kind === 'hem' ? hems[0].value : null })
  }
  return parts
}

/** Градусы, минуты и секунды части → десятичные градусы со знаком; null — не координата. */
function degrees(part: Part): number | null {
  const [d, m, s] = part.numbers
  if (!d) return null
  // Минуты и секунды — целые, кроме последнего числа части
  if (m && (m.value >= 60 || (s && !Number.isInteger(m.value)))) return null
  if (s && s.value >= 60) return null
  if ((m || s) && !Number.isInteger(d.value)) return null
  if (m?.negative || s?.negative) return null
  const value = d.value + (m?.value ?? 0) / 60 + (s?.value ?? 0) / 3600
  const south = part.hemisphere === 's' || part.hemisphere === 'w'
  // «-38 ю. ш.» — противоречие, а не север
  if (d.negative && south) return null
  return d.negative || south ? -value : value
}

const validLat = (value: number) => Math.abs(value) <= 90
const validLon = (value: number) => Math.abs(value) <= 180

/**
 * Разбор координат строки поиска: «38.56, 68.78», «38,56 68,78»,
 * «38.56N 68.78E», «38°33'36"N 68°46'48"E», «38 33 36 с.ш. 68 46 48 в.д.»,
 * градусы и десятичные минуты. Без полушарий — «широта, долгота», как у
 * навигаторов; если оба числа — возможные широты, второй вариант —
 * «долгота, широта». Не координаты — пустой список.
 */
export function parseCoordinates(text: string): CoordinateCandidate[] {
  if (!/\d/.test(text)) return []
  const tokens = tokenize(normalize(text))
  if (!tokens) return []
  const parts = split(tokens)
  if (!parts) return []
  const [first, second] = parts as [Part, Part]
  const a = degrees(first)
  const b = degrees(second)
  if (a === null || b === null) return []

  if (first.hemisphere || second.hemisphere) {
    const axis = (hem: Hemisphere | null) => (hem === 'n' || hem === 's' ? 'lat' : 'lon')
    const axisA = first.hemisphere ? axis(first.hemisphere) : null
    const axisB = second.hemisphere ? axis(second.hemisphere) : null
    // Одна буква задаёт и вторую ось
    const resolvedA = axisA ?? (axisB === 'lat' ? 'lon' : 'lat')
    const resolvedB = axisB ?? (resolvedA === 'lat' ? 'lon' : 'lat')
    if (resolvedA === resolvedB) return []
    const lat = resolvedA === 'lat' ? a : b
    const lon = resolvedA === 'lat' ? b : a
    return validLat(lat) && validLon(lon) ? [{ lat, lon, order: 'hemisphere' }] : []
  }

  const out: CoordinateCandidate[] = []
  if (validLat(a) && validLon(b)) out.push({ lat: a, lon: b, order: 'latlon' })
  if (validLat(b) && validLon(a) && a !== b) out.push({ lat: b, lon: a, order: 'lonlat' })
  return out
}

/** Подписи полушарий на языке интерфейса: «с. ш.», «в. д.» или N, E. */
export interface HemisphereLabels {
  n: string
  s: string
  e: string
  w: string
}

/** Десятичные градусы «широта, долгота» — строка, которую понимает и поиск. */
export function formatDecimal({ lon, lat }: LonLat, digits = 5): string {
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`
}

/** Десятичные градусы с полушариями: «38.56000° с. ш., 68.78000° в. д.». */
export function formatHemispheres({ lon, lat }: LonLat, labels: HemisphereLabels): string {
  const ns = lat < 0 ? labels.s : labels.n
  const ew = lon < 0 ? labels.w : labels.e
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lon).toFixed(5)}° ${ew}`
}

/** Градусы, минуты, секунды одной оси: «38°33′36″ с. ш.». */
export function formatDmsAxis(
  value: number,
  axis: 'lat' | 'lon',
  labels: HemisphereLabels,
): string {
  const hemisphere =
    axis === 'lat' ? (value < 0 ? labels.s : labels.n) : value < 0 ? labels.w : labels.e
  let total = Math.round(Math.abs(value) * 3600)
  const d = Math.floor(total / 3600)
  total -= d * 3600
  const m = Math.floor(total / 60)
  const s = total - m * 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d}°${pad(m)}′${pad(s)}″ ${hemisphere}`
}

export function formatDms({ lon, lat }: LonLat, labels: HemisphereLabels): string {
  return `${formatDmsAxis(lat, 'lat', labels)} ${formatDmsAxis(lon, 'lon', labels)}`
}

/**
 * Знаменатель численного масштаба «1 : N» для вида карты: метры в пикселе у
 * центра (тайлы MapLibre — 512 px на мир при нулевом зуме) и пиксель CSS — 0,264 мм.
 */
export function scaleDenominator(zoom: number, latitude: number): number {
  const metersPerPixel = (40_075_016.686 * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom)
  return metersPerPixel / (0.0254 / 96)
}

/** Круглый знаменатель масштаба: две значащие цифры. */
export function roundScale(denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(denominator)) - 1)
  return Math.round(denominator / magnitude) * magnitude
}
