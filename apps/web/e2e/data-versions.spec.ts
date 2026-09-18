import { expect, test } from './fixtures.js'

/**
 * Откат датасета к прежней версии (P1-E01 S04, ADR-0062): правка строки
 * отменяется из вкладки «Версии» — новой версией «Откат», таблица показывает
 * прежнее значение. Датасет и правка — по API.
 */
test.describe('Данные: версии', () => {
  test('откат к прежней версии возвращает значения новой версией', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Остатки ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'amount', label: { ru: 'Сумма' }, type: 'number', semantic: 'measure' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: { rows: [{ values: { code: `V-${run}`, amount: 1250 } }] },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const row = (await inserted.json()).items[0] as { _id: string; _ver: number }
    const patched = await request.patch(`/api/v1/datasets/${datasetId}/rows/${row._id}`, {
      headers,
      data: { values: { amount: 9999 }, ver: row._ver },
    })
    expect(patched.ok(), await patched.text()).toBeTruthy()

    await page.goto(`/o/${datasetId}`)
    await page.getByRole('tab', { name: 'Версии', exact: true }).click()
    await page.getByRole('button', { name: 'Откатить к версии 2' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Откатить' }).click()
    await expect(page.getByText('Датасет откачен к версии 2')).toBeVisible()
    const latest = page.getByRole('listitem').filter({ hasText: 'Версия 4' })
    await expect(latest.getByText('Откат', { exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Таблица', exact: true }).click()
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('gridcell', { name: /1\s?250/ })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: /9\s?999/ })).toHaveCount(0)
  })
})
