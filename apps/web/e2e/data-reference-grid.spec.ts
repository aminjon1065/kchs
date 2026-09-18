import { expect, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 1 №2 (04-verification.md): справочник «Типы», поле
 * связывается с ним в схеме — в гриде видны подписи; правка трёх ячеек, вставка
 * 100 строк из буфера, отмена одной правки (⌘Z). Справочник и таблица — по API,
 * связь, правка, вставка и отмена — в интерфейсе.
 */
test.describe('Данные: справочник и правка в гриде', () => {
  test('справочник → подписи в гриде → 3 правки → 100 строк из буфера → отмена правки', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]

    const types = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Типы ${run}`,
        spaceId: space?.id,
        kind: 'reference',
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(types.ok(), await types.text()).toBeTruthy()
    const typesId = (await types.json()).id as string
    const typeRows = await request.post(`/api/v1/datasets/${typesId}/rows`, {
      headers,
      data: {
        rows: [
          ['FL', 'Паводок'],
          ['MF', 'Сель'],
          ['FI', 'Пожар'],
        ].map(([code, name]) => ({ values: { code, name } })),
      },
    })
    expect(typeRows.ok(), await typeRows.text()).toBeTruthy()

    const journal = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Журнал ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Номер' }, type: 'identifier' },
          { key: 'kind', label: { ru: 'Тип' }, type: 'text', semantic: 'category' },
          { key: 'amount', label: { ru: 'Сумма' }, type: 'number', semantic: 'measure' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(journal.ok(), await journal.text()).toBeTruthy()
    const journalId = (await journal.json()).id as string
    const seeded = await request.post(`/api/v1/datasets/${journalId}/rows`, {
      headers,
      data: {
        rows: [
          ['FL', 10],
          ['MF', 20],
          ['FI', 30],
        ].map(([kind, amount], index) => ({ values: { code: `J-${run}-${index}`, kind, amount } })),
      },
    })
    expect(seeded.ok(), await seeded.text()).toBeTruthy()

    // Схема: поле «Тип» связано со справочником — ключ «Код», подпись «Название»
    await page.goto(`/o/${journalId}`)
    await page.getByRole('tab', { name: 'Схема', exact: false }).click()
    await page.getByRole('button', { name: 'Тип', exact: true }).click()
    await page.getByRole('tab', { name: 'Свойства', exact: true }).click()
    await page.getByRole('combobox', { name: 'Датасет-справочник' }).click()
    await page.getByRole('option', { name: `Типы ${run}` }).click()
    await page.getByRole('combobox', { name: 'Поле ключа' }).click()
    await page.getByRole('option', { name: 'Код' }).click()
    await page.getByRole('combobox', { name: 'Поле подписи' }).click()
    await page.getByRole('option', { name: 'Название' }).click()
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Поле сохранено')).toBeVisible()

    // Таблица: подписи вместо кодов
    await page.getByRole('tab', { name: 'Таблица', exact: true }).click()
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('gridcell', { name: 'Паводок' })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: 'FL', exact: true })).toHaveCount(0)

    // Три правки суммы
    const rowOf = (index: number) => grid.getByRole('row').filter({ hasText: `J-${run}-${index}` })
    for (const [index, value] of [
      [0, '11'],
      [1, '22'],
      [2, '33'],
    ] as const) {
      await rowOf(index).getByRole('gridcell').nth(2).click()
      await page.keyboard.type(value)
      await page.keyboard.press('Enter')
      await expect(rowOf(index).getByRole('gridcell').nth(2)).toHaveText(value)
    }

    // 100 строк из буфера: «Добавить строки» и вставка с первого столбца
    await rowOf(0).getByRole('gridcell').nth(0).click()
    await page.getByRole('button', { name: 'Добавить строки' }).click()
    const tsv = Array.from({ length: 100 }, (_, i) => `N-${run}-${i}\tFL\t${i}`).join('\n')
    await grid.evaluate((element, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, tsv)
    await expect(page.getByText(/Добавлено 100 строк/)).toBeVisible({ timeout: 30_000 })
    const counted = async () => {
      const response = await request.post(`/api/v1/datasets/${journalId}/rows/query`, {
        headers,
        data: { limit: 1, count: true },
      })
      return (await response.json()).rowCount as number
    }
    await expect.poll(counted).toBe(103)

    // Отмена одной правки: последняя правка суммы возвращается
    await rowOf(2).getByRole('gridcell').nth(2).click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByText('Правка отменена')).toBeVisible()
    await expect(rowOf(2).getByRole('gridcell').nth(2)).toHaveText('30')
    await expect(rowOf(1).getByRole('gridcell').nth(2)).toHaveText('22')
  })
})
