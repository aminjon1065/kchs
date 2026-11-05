// Стилизованная карта экрана входа (ADR-0230): контуры районов Таджикистана из сида
// территорий — упрощённые, в координатах viewBox, без внешних запросов (CSP).
//   node apps/web/scripts/build-login-map.mjs
// Источник — apps/api/src/seed/territory-boundaries.json (geoBoundaries, ODbL: подпись
// авторства на карте обязательна) и центры городов из territories.json.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SEED = path.join(ROOT, 'apps/api/src/seed')
const OUT = path.join(ROOT, 'apps/web/src/features/auth/login-map-data.ts')

const WIDTH = 1000
/** Допуск упрощения, единицы viewBox: на экране входа карта ~900 px шириной. */
const EPSILON = 0.9
/** Подписанные города: столица и центры двух областей по краям страны. */
const CITIES = [
  { code: 'TJ-DU', capital: true },
  { code: 'TJ-SU-01', capital: false },
  { code: 'TJ-GB-01', capital: false },
]

const boundaries = JSON.parse(readFileSync(path.join(SEED, 'territory-boundaries.json'), 'utf8'))
const territories = JSON.parse(readFileSync(path.join(SEED, 'territories.json'), 'utf8'))

const rings = []
for (const unit of boundaries.units) {
  const polygons =
    unit.geometry.type === 'Polygon' ? [unit.geometry.coordinates] : unit.geometry.coordinates
  for (const polygon of polygons) for (const ring of polygon) rings.push(ring)
}

let minLon = Infinity
let maxLon = -Infinity
let minLat = Infinity
let maxLat = -Infinity
for (const ring of rings) {
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon)
    maxLon = Math.max(maxLon, lon)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }
}

// Равнопромежуточная проекция с поправкой на широту середины страны
const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
const scale = WIDTH / ((maxLon - minLon) * kx)
const HEIGHT = Math.round((maxLat - minLat) * scale)
const project = ([lon, lat]) => [(lon - minLon) * kx * scale, (maxLat - lat) * scale]

/** Расстояние от точки до отрезка — для Дугласа — Пекера. */
function distance([x, y], [x1, y1], [x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const length = dx * dx + dy * dy
  if (length === 0) return Math.hypot(x - x1, y - y1)
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

function simplify(points) {
  if (points.length <= 2) return points
  let farthest = 0
  let at = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = distance(points[i], points[0], points[points.length - 1])
    if (d > farthest) {
      farthest = d
      at = i
    }
  }
  if (farthest <= EPSILON) return [points[0], points[points.length - 1]]
  return [...simplify(points.slice(0, at + 1)).slice(0, -1), ...simplify(points.slice(at))]
}

const round = (value) => Math.round(value * 10) / 10
const parts = []
for (const ring of rings) {
  const points = simplify(ring.map(project))
  if (points.length < 4) continue
  parts.push(
    `M${points
      .slice(0, -1)
      .map(([x, y]) => `${round(x)} ${round(y)}`)
      .join('L')}Z`,
  )
}

const cities = CITIES.map(({ code, capital }) => {
  const territory = territories.find((item) => item.code === code)
  if (!territory) throw new Error(`нет территории ${code}`)
  const [x, y] = project(territory.centroid)
  const [lon, lat] = territory.centroid
  return { code, capital, x: round(x), y: round(y), lon, lat, name: territory.name }
})

const source = `// Создано apps/web/scripts/build-login-map.mjs — не править вручную.
// Контуры районов: ${boundaries.source}, ${boundaries.license}.
export interface LoginMapCity {
  code: string
  capital: boolean
  x: number
  y: number
  lon: number
  lat: number
  name: { ru: string; tg: string; en: string }
}

export const LOGIN_MAP: {
  width: number
  height: number
  districts: string
  cities: readonly LoginMapCity[]
} = {
  width: ${WIDTH},
  height: ${HEIGHT},
  districts: '${parts.join('')}',
  cities: JSON.parse(
    // i18n-ignore — названия городов из сида территорий (ru, tg, en), а не тексты интерфейса
    '${JSON.stringify(cities)}',
  ),
}
`
writeFileSync(OUT, source)
// Вывод — в стиле репозитория (кавычки и переносы biome)
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', OUT], { cwd: ROOT, stdio: 'ignore' })
process.stdout.write(
  `${path.relative(ROOT, OUT)}: ${parts.length} контуров, ${(source.length / 1024).toFixed(1)} КБ\n`,
)
