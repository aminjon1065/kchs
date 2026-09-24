import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db, registerLifecycle, setupFixture } from './helpers.js'

/**
 * Численность населения территорий (вопрос N7): официальная статистика поверх оценок
 * справочника — число, источник, дата и способ в атрибутах единицы, повтор без изменений,
 * представление `ds.sys_territories` отдаёт новое число хороплетам и паспорту.
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const json = { with: { type: 'json' } } as const
const TERRITORIES = (await import('../src/seed/territories.json', json)).default
const POPULATION = (await import('../src/seed/territory-population.json', json)).default

beforeAll(async () => {
  await setupFixture()
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
})

const attributesOf = async (code: string) => {
  const [row] = await db().execute<{ attributes: Record<string, unknown> }>(
    sql`SELECT attributes FROM territories WHERE code = ${code}`,
  )
  return row?.attributes ?? {}
}

describe('численность населения', () => {
  it('загружает статистику с происхождением и не повторяет загрузку', async () => {
    const first = await db().transaction((tx) =>
      TerritoryService.loadPopulation(tx, systemCtx('test'), POPULATION),
    )
    // Страна, 5 регионов и 68 районов — у всех оценки справочника отличаются от статистики
    expect(first).toBe(74)
    const again = await db().transaction((tx) =>
      TerritoryService.loadPopulation(tx, systemCtx('test'), POPULATION),
    )
    expect(again).toBe(0)

    const khujand = await attributesOf('TJ-SU-01')
    expect(khujand.population).toBe(203_800)
    expect(khujand.population_source).toEqual({
      source: POPULATION.source,
      date: '2024-01-01',
      method: 'official',
    })
    // Город с одноимённым районом — сумма двух строк таблицы
    expect((await attributesOf('TJ-SU-04')).population).toBe(299_300)
    expect((await attributesOf('TJ-DU-02')).population_source).toMatchObject({
      method: 'estimate_share',
    })
  })

  it('районы Душанбе в сумме дают официальный итог города', async () => {
    const [row] = await db().execute<{ total: string; city: string }>(sql`
      SELECT (SELECT sum(population) FROM ds.sys_territories WHERE code LIKE 'TJ-DU-%')::text AS total,
             (SELECT population FROM ds.sys_territories WHERE code = 'TJ-DU')::text AS city`)
    expect(row).toEqual({ total: '1242600', city: '1242600' })
  })

  it('изменение числа перезаписывает только изменившуюся единицу', async () => {
    const changed = await db().transaction((tx) =>
      TerritoryService.loadPopulation(tx, systemCtx('test'), {
        ...POPULATION,
        units: POPULATION.units.map((unit) =>
          unit.code === 'TJ-GB-05' ? { ...unit, population: 16_800 } : unit,
        ),
      }),
    )
    expect(changed).toBe(1)
    expect((await attributesOf('TJ-GB-05')).population).toBe(16_800)
  })

  it('неизвестный код и дробное число отклоняются', async () => {
    const load = (units: Array<{ code: string; population: number; method: string }>) =>
      db().transaction((tx) =>
        TerritoryService.loadPopulation(tx, systemCtx('test'), { ...POPULATION, units }),
      )
    await expect(load([{ code: 'TJ-XX-99', population: 1, method: 'official' }])).rejects.toThrow(
      /Нет территории/,
    )
    await expect(load([{ code: 'TJ-SU-01', population: 1.5, method: 'official' }])).rejects.toThrow(
      /не целое/,
    )
  })
})
