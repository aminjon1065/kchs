import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Справочник территорий (P1-E07 S03, ADR-0057): загрузка из seed-файла,
 * дерево и карточка, видимость всем сотрудникам, территории ответственности
 * подразделений (`@my_territories`).
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/gis/public.js')
const { computePrincipalSet } = await import('../src/kernel/access/principal-set.js')
const { systemCtx } = await import('../src/shared/context.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
const ids = new Map<string, string>()

beforeAll(async () => {
  fx = await setupFixture()
  const created = await db().transaction((tx) =>
    TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never),
  )
  expect(created).toBe(TERRITORIES.length)
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) ids.set(item.code, item.id)
})

describe('справочник территорий', () => {
  it('загрузка из seed-файла повторяема: страна, 5 регионов, районы, замыкание', async () => {
    const again = await db().transaction((tx) =>
      TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never),
    )
    expect(again).toBe(0)

    const list = await call(fx.app, { url: '/territories', as: fx.users.stranger })
    expect(list.statusCode, list.body).toBe(200)
    const items = list.json().items as Array<{ code: string; level: string; parentId: string }>
    expect(items).toHaveLength(TERRITORIES.length)
    expect(items.filter((item) => item.level === 'region')).toHaveLength(5)
    const khatlon = items.find((item) => item.code === 'TJ-KT')
    expect(khatlon).toMatchObject({ parentId: ids.get('TJ'), level: 'region' })
    const bokhtar = items.find((item) => item.code === 'TJ-KT-01') as unknown as {
      centroid: { lon: number; lat: number }
      kind: string
    }
    expect(bokhtar.kind).toBe('город')
    expect(bokhtar.centroid.lon).toBeCloseTo(68.781, 3)

    // Замыкание: у района три строки — он сам, регион и страна
    const closure = await db().execute<{ depth: number }>(
      sql`SELECT depth FROM territory_closure WHERE territory_id = ${ids.get('TJ-KT-01')} ORDER BY depth`,
    )
    expect(closure.map((row) => row.depth)).toEqual([0, 1, 2])
  })

  it('карточка: путь от корня, дочерние единицы; видна любому сотруднику', async () => {
    const district = await call(fx.app, {
      url: `/territories/${ids.get('TJ-KT-01')}`,
      as: fx.users.stranger,
    })
    expect(district.statusCode, district.body).toBe(200)
    expect(district.json().path.map((item: { code: string }) => item.code)).toEqual(['TJ', 'TJ-KT'])
    expect(district.json().attributes).toMatchObject({ kind: 'город', population: 130_000 })

    const region = await call(fx.app, { url: `/territories/${ids.get('TJ-KT')}`, as: fx.admin })
    expect(region.json().children.length).toBe(25)
    expect(region.json().path.map((item: { code: string }) => item.code)).toEqual(['TJ'])

    const missing = await call(fx.app, {
      url: '/territories/00000000-0000-7000-8000-000000000000',
      as: fx.admin,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('территории ответственности: своя или ближайшего предка по оргструктуре', async () => {
    const member = fx.users.member.id
    expect((await computePrincipalSet(member)).territoryIds).toEqual([])
    const regional = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${fx.unitId}`,
      as: fx.admin,
      payload: { kind: 'regional', sort: 5 },
    })
    expect(regional.statusCode, regional.body).toBe(200)

    const assign = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${fx.unitId}`,
      as: fx.admin,
      payload: { territoryId: ids.get('TJ-KT') },
    })
    expect(assign.statusCode, assign.body).toBe(200)
    expect((await computePrincipalSet(member)).territoryIds).toEqual([ids.get('TJ-KT')])

    // Правка одной территории не сбрасывает прочие поля подразделения
    const units = await call(fx.app, { url: '/org/units', as: fx.admin })
    const unit = units.json().items.find((item: { id: string }) => item.id === fx.unitId) as Record<
      string,
      unknown
    >
    expect(unit).toMatchObject({ kind: 'regional', sort: 5, territoryId: ids.get('TJ-KT') })

    const unknown = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${fx.unitId}`,
      as: fx.admin,
      payload: { territoryId: '00000000-0000-7000-8000-000000000000' },
    })
    expect(unknown.statusCode).toBe(400)
  })
})
