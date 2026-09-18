import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Территории и справочники в данных (P1-E07, ADR-0057): поле-территория с
 * вводом по коду и названию, агрегация по уровню `territory_level()`, подписи
 * `territory_name()`, `within` с вложенными, политика «только своя область»
 * через `@my_territories`, подписи справочника `lookup_label()`.
 */
registerLifecycle()

const { TerritoryService } = await import('../src/modules/gis/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { db } = await import('../src/shared/db/client.js')
const TERRITORIES = (await import('../src/seed/territories.json', { with: { type: 'json' } }))
  .default

let fx: TestContext
let datasetId: string
let typesId: string
const ids = new Map<string, string>()
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  await db().transaction((tx) => TerritoryService.load(tx, systemCtx('test'), TERRITORIES as never))
  await TerritoryService.invalidate()
  for (const item of await TerritoryService.list()) ids.set(item.code, item.id)

  // Справочник типов — отдельный датасет
  const types = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Типы ${run}`,
      spaceId: fx.spaceId,
      kind: 'reference',
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(types.statusCode, types.body).toBe(200)
  typesId = types.json().id
  const typeRows = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${typesId}/rows`,
    as: fx.admin,
    payload: {
      rows: [{ values: { code: 'FL', name: 'Паводок' } }, { values: { code: 'MF', name: 'Сель' } }],
    },
  })
  expect(typeRows.statusCode, typeRows.body).toBe(200)

  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier' },
        { key: 'place', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
        { key: 'kind', label: { ru: 'Тип' }, type: 'text' },
        { key: 'victims', label: { ru: 'Пострадавшие' }, type: 'integer' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const link = await call(fx.app, {
    method: 'PATCH',
    url: `/datasets/${datasetId}/fields/kind`,
    as: fx.admin,
    payload: { lookup: { datasetId: typesId, keyField: 'code', labelField: 'name' } },
  })
  expect(link.statusCode, link.body).toBe(200)

  // Территория — кодом, названием (на любом языке) или идентификатором
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        { values: { code: 'I-1', place: 'TJ-KT-01', kind: 'FL', victims: 2 } },
        { values: { code: 'I-2', place: 'Куляб', kind: 'MF', victims: 1 } },
        { values: { code: 'I-3', place: 'khujand', kind: 'FL', victims: 0 } },
        { values: { code: 'I-4', place: ids.get('TJ-DU-02'), kind: 'XX', victims: 5 } },
      ],
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
})

const runQuery = (steps: unknown[], as: TestUser = fx.admin) =>
  call(fx.app, {
    method: 'POST',
    url: '/queries/run',
    as,
    payload: { spec: { version: 1, source: { kind: 'dataset', id: datasetId }, steps } },
  })

/** Строки результата как объекты по именам полей. */
function records(body: { fields: Array<{ name: string }>; rows: unknown[][] }) {
  return body.rows.map((row) => Object.fromEntries(body.fields.map((f, i) => [f.name, row[i]])))
}

describe('поле-территория', () => {
  it('значение — идентификатор справочника; неизвестная территория — ошибка поля', async () => {
    const rows = await runQuery([{ type: 'sort', by: [{ field: 'code', dir: 'asc' }] }])
    expect(rows.statusCode, rows.body).toBe(200)
    expect(records(rows.json()).map((row) => row.place)).toEqual([
      ids.get('TJ-KT-01'),
      ids.get('TJ-KT-02'),
      ids.get('TJ-SU-01'),
      ids.get('TJ-DU-02'),
    ])
    expect(rows.json().fields.find((f: { name: string }) => f.name === 'place').type).toBe(
      'territory',
    )

    const unknown = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'I-9', place: 'Атлантида' } }] },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().errors[0]).toEqual({
      path: 'place',
      message: 'Нет территории «Атлантида»',
    })
  })
})

describe('территории в запросах', () => {
  it('агрегация по уровню: районы → регионы, подписи на языке пользователя', async () => {
    const response = await runQuery([
      {
        type: 'compute',
        fields: [
          { name: 'region', expr: "territory_level(place, 'region')" },
          { name: 'region_name', expr: 'territory_name(region)' },
        ],
      },
      {
        type: 'aggregate',
        groupBy: [{ field: 'region' }, { field: 'region_name' }],
        measures: [{ alias: 'victims', agg: 'sum', field: 'victims' }],
      },
      { type: 'sort', by: [{ field: 'region_name', dir: 'asc' }] },
    ])
    expect(response.statusCode, response.body).toBe(200)
    expect(records(response.json())).toEqual([
      { region: ids.get('TJ-DU'), region_name: 'Душанбе', victims: 5 },
      { region: ids.get('TJ-SU'), region_name: 'Согдийская область', victims: 0 },
      { region: ids.get('TJ-KT'), region_name: 'Хатлонская область', victims: 3 },
    ])
    expect(response.json().fields[0]).toMatchObject({ name: 'region', type: 'territory' })
  })

  it('within: регион со всеми районами; без вложенных — только сам регион', async () => {
    const within = (includeChildren: boolean) =>
      runQuery([
        {
          type: 'filter',
          where: { field: 'place', op: 'within', value: { id: ids.get('TJ-KT'), includeChildren } },
        },
      ])
    const all = await within(true)
    expect(all.statusCode, all.body).toBe(200)
    expect(records(all.json()).map((row) => row.code)).toEqual(
      expect.arrayContaining(['I-1', 'I-2']),
    )
    expect(all.json().rows).toHaveLength(2)
    expect((await within(false)).json().rows).toHaveLength(0)
  })

  it('политика «только своя область»: within @my_territories по подразделению', async () => {
    const policy = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'everyone', id: '*' },
        filter: { field: 'place', op: 'within', value: '@my_territories' },
      },
    })
    expect(policy.statusCode, policy.body).toBe(200)
    const assign = await call(fx.app, {
      method: 'PATCH',
      url: `/org/units/${fx.unitId}`,
      as: fx.admin,
      payload: { territoryId: ids.get('TJ-KT') },
    })
    expect(assign.statusCode, assign.body).toBe(200)

    const codes = async (user: TestUser) => {
      const response = await runQuery([{ type: 'sort', by: [{ field: 'code', dir: 'asc' }] }], user)
      expect(response.statusCode, response.body).toBe(200)
      return records(response.json()).map((row) => row.code)
    }
    // Сотрудник хатлонского подразделения — только Хатлон
    expect(await codes(fx.users.member)).toEqual(['I-1', 'I-2'])
    // Читатель без подразделения — ничего; владелец (manage+) — всё
    expect(await codes(fx.users.viewer)).toEqual([])
    expect(await codes(fx.admin)).toHaveLength(4)

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/rows/${policy.json().id}`,
      as: fx.admin,
    })
    expect(removed.statusCode).toBe(200)
  })
})

describe('подписи справочника', () => {
  it('lookup_label: подписи по ключу; нет строки справочника — пусто', async () => {
    const response = await runQuery([
      { type: 'compute', fields: [{ name: 'kind_label', expr: 'lookup_label(kind)' }] },
      { type: 'sort', by: [{ field: 'code', dir: 'asc' }] },
    ])
    expect(response.statusCode, response.body).toBe(200)
    expect(records(response.json()).map((row) => row.kind_label)).toEqual([
      'Паводок',
      'Сель',
      'Паводок',
      null,
    ])
  })

  it('справочник недоступен пользователю — подписей нет, значения не раскрываются', async () => {
    // Закрытый справочник — в общем пространстве, где читателя нет
    const secret = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Закрытые типы ${run}`,
        spaceId: fx.orgSpaceId,
        kind: 'reference',
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(secret.statusCode, secret.body).toBe(200)
    const secretId = secret.json().id
    await call(fx.app, {
      method: 'POST',
      url: `/datasets/${secretId}/rows`,
      as: fx.admin,
      payload: { rows: [{ values: { code: 'FL', name: 'Секретный паводок' } }] },
    })
    const hidden = await call(fx.app, { url: `/datasets/${secretId}`, as: fx.users.viewer })
    expect(hidden.statusCode).toBe(404)
    const relink = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/fields/kind`,
      as: fx.admin,
      payload: { lookup: { datasetId: secretId, keyField: 'code', labelField: 'name' } },
    })
    expect(relink.statusCode, relink.body).toBe(200)

    const labels = async (user: TestUser) => {
      const response = await runQuery(
        [{ type: 'compute', fields: [{ name: 'kind_label', expr: 'lookup_label(kind)' }] }],
        user,
      )
      expect(response.statusCode, response.body).toBe(200)
      return new Set(records(response.json()).map((row) => row.kind_label))
    }
    expect(await labels(fx.users.viewer)).toEqual(new Set([null]))
    expect(await labels(fx.admin)).toEqual(new Set(['Секретный паводок', null]))
  })
})
