import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Качество данных (P5-E03, ADR-0101): правила датасета проверяются на текущей
 * версии, нарушения видны с примерами строк, статус — сводкой. Правила ведёт
 * уровень `manage`, читает — любой, кто видит датасет.
 */
registerLifecycle()

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''

async function rows(values: Array<Record<string, unknown>>): Promise<void> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: { rows: values.map((item) => ({ values: item })) },
  })
  expect(response.statusCode, response.body).toBe(200)
}

const setRules = (rules: unknown[], as = fx.admin) =>
  call(fx.app, {
    method: 'PUT',
    url: `/datasets/${datasetId}/quality/rules`,
    as,
    payload: { rules },
  })

const check = (as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/datasets/${datasetId}/quality/run`, as })

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Обращения ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'people', label: { ru: 'Людей' }, type: 'integer', semantic: 'measure' },
      ],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id as string

  await rows([
    { code: 'A-1', district: 'Хатлон', people: 5 },
    { code: 'A-2', district: 'Согд', people: 900 },
    { code: 'A-2', district: null, people: 3 },
  ])
})

describe('правила качества', () => {
  it('находят пропуски, повторы и выход за диапазон с примерами строк', async () => {
    const saved = await setRules([
      { key: 'district_filled', kind: 'not_null', field: 'district', severity: 'error' },
      { key: 'code_unique', kind: 'unique', field: 'code', severity: 'error' },
      {
        key: 'people_range',
        kind: 'range',
        field: 'people',
        params: { min: 0, max: 100 },
        severity: 'warning',
      },
    ])
    expect(saved.statusCode, saved.body).toBe(200)

    const report = await check()
    expect(report.statusCode, report.body).toBe(200)
    const body = report.json()
    expect(body.status).toBe('failed')

    const byKey = Object.fromEntries(
      (body.results as Array<{ key: string; sample: string[] }>).map((item) => [item.key, item]),
    )
    expect(byKey.district_filled).toMatchObject({ status: 'failed', failed: 1 })
    expect(byKey.district_filled?.sample).toHaveLength(1)
    expect(byKey.code_unique).toMatchObject({ status: 'failed' })
    expect(byKey.people_range).toMatchObject({ status: 'failed', failed: 1, severity: 'warning' })
  })

  it('без нарушений статус «ok», предупреждение не роняет сводку', async () => {
    const saved = await setRules([
      { key: 'code_filled', kind: 'not_null', field: 'code', severity: 'error' },
    ])
    expect(saved.statusCode, saved.body).toBe(200)
    const report = await check()
    expect(report.json().status).toBe('ok')

    await setRules([
      { key: 'code_filled', kind: 'not_null', field: 'code', severity: 'error' },
      {
        key: 'people_range',
        kind: 'range',
        field: 'people',
        params: { min: 0, max: 100 },
        severity: 'warning',
      },
    ])
    expect((await check()).json().status).toBe('warning')
  })

  it('правило на несуществующее поле не принимается', async () => {
    const response = await setRules([{ key: 'ghost', kind: 'not_null', field: 'no_such_field' }])
    expect(response.statusCode, response.body).toBe(400)
  })

  it('правила ведёт только manage, читают все, кто видит датасет', async () => {
    const viewer = await setRules(
      [{ key: 'code_filled', kind: 'not_null', field: 'code' }],
      fx.users.viewer,
    )
    expect(viewer.statusCode).toBe(403)

    const read = await call(fx.app, {
      url: `/datasets/${datasetId}/quality`,
      as: fx.users.viewer,
    })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().canManage).toBe(false)

    const stranger = await call(fx.app, {
      url: `/datasets/${datasetId}/quality`,
      as: fx.users.stranger,
    })
    expect(stranger.statusCode, 'постороннему датасета не видно').toBe(404)
  })

  it('повторы ключей правил не принимаются', async () => {
    const response = await setRules([
      { key: 'code_filled', kind: 'not_null', field: 'code' },
      { key: 'code_filled', kind: 'not_null', field: 'district' },
    ])
    expect(response.statusCode).toBe(400)
  })
})
