import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 1 №4 (04-verification.md): показатель с порогом, на
 * дашборде — число со сравнением с прошлым периодом, TV-режим.
 */
test.describe('Данные: показатели', () => {
  test('показатель с порогом на дашборде и в TV-режиме', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)

    // Датасет со случаями этого месяца — по API: сценарий проверяет показатель
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
      name: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Случаи ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
          { key: 'at', label: { ru: 'Когда' }, type: 'datetime', semantic: 'time' },
        ],
        primaryKey: ['code'],
        timeField: 'at',
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const rows = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: ['Хатлон', 'Согд', 'ГБАО'].map((district, index) => ({
          values: { code: `S-${index}`, district, at: new Date().toISOString() },
        })),
      },
    })
    expect(rows.ok(), await rows.text()).toBeTruthy()

    // Показатель с порогом — в редакторе из каталога «Данные»
    await page.getByRole('button', { name: 'Данные' }).first().click()
    const catalog = page.getByRole('region', { name: 'Данные' })
    if (space && spaces.length > 1) {
      await catalog.getByRole('button', { name: space.name, exact: true }).click()
    }
    await catalog.getByRole('button', { name: 'Показатель', exact: true }).click()
    const editor = page.getByRole('dialog')
    const metricName = `Случаи за месяц ${run}`
    await editor.getByRole('textbox', { name: 'Название' }).fill(metricName)
    await editor.getByRole('combobox', { name: 'Датасет' }).click()
    await page.getByRole('option', { name: `Случаи ${run}` }).click()
    await editor.getByRole('button', { name: 'Порог', exact: true }).click()
    await editor.getByRole('spinbutton', { name: 'Порог' }).fill('2')
    await editor.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(metricName) })).toBeVisible()
    // Значение за этот месяц — три случая, порог «Внимание» с двух
    await expect(page.getByText('от 2 — Внимание')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('к прошлому периоду').first()).toBeVisible()

    // На новый дашборд: плитка — число со сравнением
    const dashboardName = `Сводка ${run}`
    await page.getByRole('button', { name: 'На дашборд' }).click()
    await page.getByRole('textbox', { name: 'Название' }).fill(dashboardName)
    await page.getByRole('dialog').getByRole('button', { name: 'На дашборд' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(dashboardName) })).toBeVisible()
    await expect(page.getByText('Этот месяц')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('к прошлому периоду')).toBeVisible()

    // TV-режим: поверх оболочки, выход — Esc
    await page.getByRole('button', { name: 'TV', exact: true }).click()
    const tv = page.getByRole('dialog', { name: `${dashboardName} — TV-режим` })
    await expect(tv).toBeVisible()
    await expect(tv.getByText(metricName)).toBeVisible()
    await expect(tv.getByText(/Обновлено/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tv).toBeHidden()
  })
})
