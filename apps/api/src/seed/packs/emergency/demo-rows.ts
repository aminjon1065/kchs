import { sql } from 'drizzle-orm'
import { DatasetService } from '~/modules/data/domain/dataset-service.js'
import { qualified } from '~/modules/data/infra/physical.js'
import { TerritoryService } from '~/modules/gis/public.js'
import { db } from '~/shared/db/client.js'
import { type PackContext, staffOf, unitId } from './context.js'
import { insertRows, rowCount } from './datasets.js'

/**
 * Демо-строки оперативных реестров штаба (только демо-мир, только пустой реестр).
 * Всё вымышлено, как и остальные демо-данные (seeds/README.md); генератор
 * детерминированный — повторная установка на чистой базе даёт те же строки.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const day = (offset: number) => {
  const date = new Date(Date.now() + offset * 24 * 3600_000)
  return date.toISOString().slice(0, 10)
}

async function centroids(): Promise<Map<string, { id: string; lon: number; lat: number }>> {
  const map = new Map<string, { id: string; lon: number; lat: number }>()
  for (const item of await TerritoryService.list()) {
    if (item.centroid) map.set(item.code, { id: item.id, ...item.centroid })
  }
  return map
}

const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/**
 * ПВР — из «Объектов защиты» вида «Пункт временного размещения»: те же точки, что на
 * слое объектов. Несколько ПВР в поймах развёрнуты: обстановка паводкового сезона.
 */
async function shelters(pack: PackContext, target: string, objects: string): Promise<number> {
  const storage = await DatasetService.storage(objects)
  const column = (key: string) => {
    const found = storage.fields.find((item) => item.key === key)
    return found ? sql.raw(`"${found.physical}"`) : null
  }
  const [code, name, type, territory, capacity, geometry] = [
    'code',
    'name',
    'object_type',
    'territory',
    'capacity',
    'geometry',
  ].map(column)
  if (!code || !name || !type || !territory || !capacity || !geometry) return 0
  const rows = await db().execute<{
    code: string
    name: string
    territory: string | null
    capacity: number | null
    geometry: unknown
  }>(sql`
    SELECT ${code} AS code, ${name} AS name, ${territory}::text AS territory,
           ${capacity}::int AS capacity, extensions.ST_AsGeoJSON(${geometry})::json AS geometry
      FROM ${sql.raw(qualified(storage.table))}
     WHERE _deleted_at IS NULL AND ${type} = 'Пункт временного размещения'
     ORDER BY ${code}
     LIMIT 400`)
  const random = makeRandom(2026_09_24)
  const deployed = new Set(['TJ-KT-10', 'TJ-KT-13', 'TJ-RA-09'])
  const codes = new Map((await TerritoryService.list()).map((item) => [item.id, item.code]))
  const heads = await staffOf(['RG-'], { prefix: true })
  const values = rows.map((row, index) => {
    const unitCode = row.territory ? codes.get(row.territory) : undefined
    const open = unitCode !== undefined && deployed.has(unitCode) && index % 3 === 0
    const size = row.capacity ?? 100 + Math.round(random() * 200)
    return {
      code: `ПВР-${row.code}`,
      name: row.name,
      territory: row.territory,
      capacity: size,
      occupied: open ? Math.round(size * (0.3 + random() * 0.5)) : 0,
      status: open ? 'deployed' : random() < 0.08 ? 'not_ready' : 'ready',
      responsible: heads.length > 0 ? 'Дежурный регионального управления' : null,
      phone: `+992 ${String(30 + Math.floor(random() * 60))} ${String(100 + Math.floor(random() * 899))}-${String(10 + Math.floor(random() * 89))}-${String(10 + Math.floor(random() * 89))}`,
      geometry: row.geometry,
    }
  })
  return values.length > 0 ? insertRows(pack, target, values) : 0
}

/** Силы и средства региональных управлений и центрального спасательного отряда. */
async function forces(pack: PackContext, target: string): Promise<number> {
  const places = await centroids()
  const units: Array<{ unit: string; territory: string; label: string; scale: number }> = [
    { unit: 'UO-RESC', territory: 'TJ-DU-02', label: 'Центральный спасательный отряд', scale: 2 },
    { unit: 'RG-SUG', territory: 'TJ-SU-01', label: 'Согдийская область', scale: 1.3 },
    { unit: 'RG-KHA', territory: 'TJ-KT-01', label: 'Хатлонская область', scale: 1.5 },
    { unit: 'RG-GBAO', territory: 'TJ-GB-01', label: 'ГБАО', scale: 0.7 },
    { unit: 'RG-DRS', territory: 'TJ-RA-01', label: 'РРП', scale: 1 },
  ]
  const kinds: Array<[string, string, number]> = [
    ['personnel', 'Спасатели', 40],
    ['rescue', 'Аварийно-спасательные автомобили', 6],
    ['fire', 'Пожарные автомобили', 8],
    ['engineering', 'Инженерная техника', 4],
    ['boats', 'Плавсредства', 3],
    ['uav', 'Беспилотники', 2],
    ['power', 'Мобильные электростанции', 4],
    ['shelter', 'Палатки', 40],
  ]
  const random = makeRandom(2026_0924)
  const rows: Array<Record<string, unknown>> = []
  for (const item of units) {
    const id = await unitId(item.unit)
    const place = places.get(item.territory)
    kinds.forEach(([kind, name, base], index) => {
      const quantity = Math.max(1, Math.round(base * item.scale * (0.8 + random() * 0.4)))
      const ready = Math.max(0, quantity - Math.round(quantity * random() * 0.25))
      rows.push({
        code: `${item.unit}-${String(index + 1).padStart(2, '0')}`,
        unit: id,
        resource_type: kind,
        name: `${name} — ${item.label}`,
        quantity,
        ready,
        territory: place?.id ?? null,
        geometry: place ? point(place.lon, place.lat) : null,
      })
    })
  }
  return insertRows(pack, target, rows)
}

/** Журнал оповещения: оповещения весеннего паводка и селя за последние две недели. */
async function warnings(pack: PackContext, target: string): Promise<number> {
  const places = await centroids()
  const entries: Array<[number, string, string, string, number, string]> = [
    [
      -12,
      'TJ-KT-10',
      'Кишлаки вдоль Пянджа ниже по течению от поста',
      'siren',
      4200,
      'Угроза подтопления: подъём уровня воды в реке Пяндж. Подготовьтесь к эвакуации, следуйте указаниям спасателей.',
    ],
    [
      -12,
      'TJ-KT-10',
      'Кишлаки вдоль Пянджа ниже по течению от поста',
      'door',
      850,
      'Подворный обход: предупреждение об угрозе подтопления и о пунктах временного размещения.',
    ],
    [
      -9,
      'TJ-RA-12',
      'Селеопасные саи Файзабадского района',
      'sms',
      12000,
      'Сильные дожди: угроза схода селей. Не находитесь в руслах саев и на склонах.',
    ],
    [
      -6,
      'TJ-RA-09',
      'Пойма Кафирнигана, джамоаты вдоль реки',
      'radio',
      35000,
      'Повышение уровня воды в реке Кафирниган. Не приближайтесь к берегу, держите детей под присмотром.',
    ],
    [
      -3,
      'TJ-GB-03',
      'Автодорога вдоль Пянджа, лавиноопасные участки',
      'telegram',
      6400,
      'Угроза камнепадов на автодороге. Движение ограничено, следуйте указаниям дорожных служб.',
    ],
    [
      -1,
      'TJ-KT-13',
      'Приграничные кишлаки у Пянджа',
      'loudspeaker',
      2300,
      'Повторное предупреждение: уровень воды у опасной отметки, ПВР развёрнуты в школах района.',
    ],
  ]
  const rows = entries.map(([offset, territory, zone, channel, coverage, message], index) => ({
    code: `ОП-${day(offset).slice(0, 4)}-${String(index + 1).padStart(4, '0')}`,
    sent_at: `${day(offset)}T${String(9 + index).padStart(2, '0')}:30:00+05:00`,
    territory: places.get(territory)?.id ?? null,
    zone,
    channel,
    coverage,
    message,
    responsible: 'Оперативный дежурный',
  }))
  return insertRows(pack, target, rows)
}

/** График дежурств на две недели назад и вперёд — ротация дежурной службы. */
async function roster(pack: PackContext, target: string): Promise<number> {
  const duty = await staffOf(['UO-DUTY'])
  const operations = await staffOf(['UO'], { prefix: true })
  const pool = [...new Set([...duty, ...operations])]
  if (pool.length < 3) return 0
  const rows: Array<Record<string, unknown>> = []
  for (let offset = -14; offset <= 14; offset += 1) {
    const at = (shift: number) => pool[(offset + 14 + shift) % pool.length] as string
    rows.push({
      duty_date: day(offset),
      shift_head: duty[(offset + 14) % Math.max(1, duty.length)] ?? at(0),
      duty_officer: at(1),
      assistant: at(2),
      phone: '+992 37 221-00-00',
      note: offset === 0 ? 'Усиленный режим: паводковый сезон' : null,
    })
  }
  return insertRows(pack, target, rows)
}

export async function seedDemoRows(pack: PackContext, ids: Map<string, string>): Promise<void> {
  if (!pack.demo) return
  const summary: Record<string, number> = {}
  const fill = async (key: string, work: (target: string) => Promise<number>) => {
    const target = ids.get(key)
    if (!target || (await rowCount(target)) > 0) return
    summary[key] = await work(target)
  }
  const objects = ids.get('protected_objects')
  if (objects && (await rowCount(objects)) > 0) {
    await fill('shelters', (target) => shelters(pack, target, objects))
  }
  await fill('forces', (target) => forces(pack, target))
  await fill('warnings_log', (target) => warnings(pack, target))
  await fill('duty_roster', (target) => roster(pack, target))
  pack.log('демо-строки реестров штаба', summary)
}
