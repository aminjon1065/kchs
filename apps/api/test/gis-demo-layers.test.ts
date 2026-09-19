import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Демо-слои и карта сида (P2-E06): слои над датасетами с отметкой `meta.demo`
 * и карта «Оперативная обстановка»; повторный сид ничего не дублирует.
 */
registerLifecycle()

const { DemoLayers } = await import('../src/modules/gis/domain/demo-layers.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
const run = Date.now().toString(36)

/** Датасет с геометрией и отметкой набора демо-данных, как у импорта сида. */
async function demoDataset(
  demo: string,
  fields: Array<Record<string, unknown>>,
  rows: Array<Record<string, unknown>>,
): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: { name: `${demo} ${run}`, spaceId: fx.spaceId, fields },
  })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id as string
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${id}/rows`,
    as: fx.admin,
    payload: { rows: rows.map((values) => ({ values })) },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  await db().transaction((tx) =>
    ObjectService.update(
      tx,
      systemCtx('test'),
      id,
      { meta: { demo }, mergeMeta: true },
      { silent: true },
    ),
  )
  return id
}

const geometry = { key: 'geometry', label: { ru: 'Геометрия' }, type: 'geometry' }
const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

beforeAll(async () => {
  fx = await setupFixture()
  await demoDataset(
    'protected_objects',
    [
      { key: 'name', label: { ru: 'Название' }, type: 'text' },
      { key: 'object_type', label: { ru: 'Тип' }, type: 'text' },
      { key: 'capacity', label: { ru: 'Вместимость' }, type: 'integer' },
      { key: 'condition', label: { ru: 'Состояние' }, type: 'text' },
      { key: 'seismic_rating', label: { ru: 'Сейсмостойкость' }, type: 'integer' },
      geometry,
    ],
    [{ name: 'Школа № 1', object_type: 'Школа', geometry: point(68.78, 38.56) }],
  )
  await demoDataset(
    'hydro_posts',
    [
      { key: 'name', label: { ru: 'Название' }, type: 'text' },
      { key: 'river', label: { ru: 'Река' }, type: 'text' },
      { key: 'danger_level_cm', label: { ru: 'Опасный уровень' }, type: 'integer' },
      geometry,
    ],
    [{ name: 'Пост', river: 'Вахш', geometry: point(69.2, 38.1) }],
  )
})

describe('демо-слои сида', () => {
  it('слои над отмеченными датасетами и карта; повтор ничего не дублирует', async () => {
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    const first = await DemoLayers.seed(ctx, fx.spaceId)
    // «Зон риска» и «Происшествий» в пространстве нет — их слоёв тоже
    expect(first).toMatchObject({ layers: 2, created: 2 })
    expect(first.mapId).toBeTruthy()

    const map = await call(fx.app, { url: `/gis/maps/${first.mapId}`, as: fx.admin })
    expect(map.statusCode, map.body).toBe(200)
    expect(map.json().name).toBe('Оперативная обстановка')
    const entries = map.json().spec.layers as Array<{ layerId: string; visible: boolean }>
    expect(entries).toHaveLength(2)
    const names: string[] = []
    for (const entry of entries) {
      const layer = await call(fx.app, { url: `/gis/layers/${entry.layerId}`, as: fx.admin })
      expect(layer.statusCode, layer.body).toBe(200)
      names.push(layer.json().name)
      if (layer.json().name === 'Объекты защиты') {
        expect(layer.json().style).toMatchObject({
          renderer: { kind: 'categorized', field: 'object_type' },
          cluster: { enabled: true, radius: 60 },
        })
      }
    }
    expect(names.sort()).toEqual(['Гидропосты', 'Объекты защиты'])

    const again = await DemoLayers.seed(ctx, fx.spaceId)
    expect(again).toEqual({ layers: 2, created: 0, mapId: first.mapId })
  })
})
