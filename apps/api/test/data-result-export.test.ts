import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Выгрузка результата запроса (ADR-0159): «Исследование» и график — `/queries/export`,
 * плитка дашборда — `/dashboards/{id}/export` с фильтрами дашборда. Результат
 * считается заново с политиками запросившего; нужна способность «Выгрузка данных».
 */
registerLifecycle()

const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let analyst: TestUser
let datasetId: string
const run = Date.now().toString(36)

const byDistrict = (id: string) => ({
  version: 1,
  source: { kind: 'dataset', id },
  steps: [
    {
      type: 'aggregate',
      groupBy: [{ field: 'district' }],
      measures: [
        { alias: 'n', agg: 'count' },
        { alias: 'sum_amount', agg: 'sum', field: 'amount' },
      ],
    },
    { type: 'sort', by: [{ field: 'district', dir: 'asc' }] },
  ],
})

const exportQuery = (payload: Record<string, unknown>, as: TestUser = analyst) =>
  call(fx.app, { method: 'POST', url: '/queries/export', as, payload })

beforeAll(async () => {
  fx = await setupFixture()
  // Аналитик: читатель пространства со способностью data.export и политикой строк
  analyst = await createUser(fx.app, `result_export_${run}`, ['employee', 'data_steward'])
  await db().transaction((tx) =>
    SpaceService.addMember(tx, systemCtx('test'), fx.spaceId, analyst.id, 'viewer'),
  )
  await redis().del(`kchs:principals:${analyst.id}`)
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Выгрузка результата ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        ['R-1', 'Хатлон', 10],
        ['R-2', 'Хатлон', 5],
        ['R-3', 'Согд', 30],
        ['R-4', '=HYPERLINK("x")', 1],
      ].map(([code, district, amount]) => ({ values: { code, district, amount } })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  const policy = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/policies/rows`,
    as: fx.admin,
    payload: {
      principal: { type: 'user', id: analyst.id },
      filter: { field: 'district', op: 'in', value: ['Хатлон', '=HYPERLINK("x")'] },
    },
  })
  expect(policy.statusCode, policy.body).toBe(200)
})

afterAll(async () => {
  await redis().del(`kchs:principals:${analyst.id}`)
})

describe('выгрузка результата запроса', () => {
  it('CSV — подписи с экрана, строки с политикой, защита от формул, имя файла', async () => {
    const response = await exportQuery({
      spec: byDistrict(datasetId),
      format: 'csv',
      name: 'Ущерб по районам',
      labels: { n: 'Количество', sum_amount: 'Сумма ущерба' },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(String(response.headers['content-disposition'])).toContain(
      `filename*=UTF-8''${encodeURIComponent('Ущерб по районам')}`,
    )
    expect(response.headers['x-kchs-export-rows']).toBe('2')
    expect(response.headers['x-kchs-export-truncated']).toBe('false')
    const lines = response.body.replace(/^﻿/, '').trim().split(/\r?\n/)
    expect(lines[0]).toBe('Район,Количество,Сумма ущерба')
    // Политика строк: «Согд» аналитику не виден; формула — с апострофом
    expect(lines.slice(1)).toEqual([`"'=HYPERLINK(""x"")",1,1`, 'Хатлон,2,15'])
  })

  it('XLSX — книга Excel; без способности «Выгрузка данных» — 403', async () => {
    const xlsx = await exportQuery({ spec: byDistrict(datasetId), format: 'xlsx', name: 'Сводка' })
    expect(xlsx.statusCode, xlsx.body).toBe(200)
    expect(xlsx.body.slice(0, 2)).toBe('PK')

    const denied = await exportQuery(
      { spec: byDistrict(datasetId), format: 'csv', name: 'Сводка' },
      fx.users.viewer,
    )
    expect(denied.statusCode).toBe(403)
  })

  it('плитка дашборда — с фильтром дашборда по привязке плитки', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/dashboards',
      as: fx.admin,
      payload: {
        name: `Выгрузка плиток ${run}`,
        spaceId: fx.spaceId,
        spec: {
          filters: [{ id: 'district', kind: 'select', label: { ru: 'Район' } }],
          tiles: [
            {
              id: 'damage',
              kind: 'chart',
              title: 'Ущерб',
              spec: {
                version: 1,
                type: 'bar',
                data: { query: byDistrict(datasetId) },
                encoding: {
                  x: { field: 'district', type: 'nominal' },
                  y: [{ field: 'sum_amount', type: 'quantitative' }],
                },
              },
              filterBindings: { district: 'district' },
              x: 0,
              y: 0,
              w: 6,
              h: 4,
            },
            { id: 'note', kind: 'text', text: 'Сводка', x: 6, y: 0, w: 6, h: 2 },
          ],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const dashboardId = created.json().id as string

    const tile = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboardId}/export`,
      as: fx.admin,
      payload: { tileId: 'damage', filters: { district: 'Согд' }, format: 'csv' },
    })
    expect(tile.statusCode, tile.body).toBe(200)
    expect(String(tile.headers['content-disposition'])).toContain(encodeURIComponent('Ущерб'))
    const lines = tile.body.replace(/^﻿/, '').trim().split(/\r?\n/)
    expect(lines.slice(1)).toEqual(['Согд,1,30'])

    const text = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboardId}/export`,
      as: fx.admin,
      payload: { tileId: 'note', format: 'csv' },
    })
    expect(text.statusCode).toBe(404)
  })
})
