import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures.js'

const MANAGER_LOGIN = 'user058'
const MANAGER_PASSWORD = process.env.SEED_USER_PASSWORD || 'Kchs!Work-2026-3v'

/**
 * Сценарий приёмки фазы 1 №5 (04-verification.md): руководитель с политикой
 * строк «только своя область» открывает дашборд — числа отличаются; экспорт
 * CSV содержит только его строки; SQL-лаборатория тоже; `SELECT * FROM
 * public.users` отклонён. Данные, политика, график и дашборд — по API
 * администратора: сценарий проверяет то, что видит руководитель.
 */
test.describe('Данные: политики доступа', () => {
  test('руководитель «только своя область»: дашборд, экспорт, SQL-лаборатория', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

    // Руководитель: роль с выгрузкой и SQL-лабораторией, читатель командного пространства
    const found = await request.get(`/api/v1/users?q=${MANAGER_LOGIN}`)
    expect(found.ok(), await found.text()).toBeTruthy()
    const manager = ((await found.json()).items as Array<{ id: string; login: string }>).find(
      (user) => user.login === MANAGER_LOGIN,
    )
    expect(manager).toBeTruthy()
    const managerId = manager?.id as string
    const roles = await request.patch(`/api/v1/users/${managerId}`, {
      headers,
      data: { roleKeys: ['employee', 'data_steward'] },
    })
    expect(roles.ok(), await roles.text()).toBeTruthy()
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const member = await request.post(`/api/v1/spaces/${space?.id}/members`, {
      headers,
      data: { userId: managerId, role: 'viewer' },
    })
    expect(member.ok(), await member.text()).toBeTruthy()

    // Датасет по областям, политика строк «только Хатлон» для руководителя
    const name = `Обстановка по областям ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'region', label: { ru: 'Область' }, type: 'text', semantic: 'category' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: ['Хатлон', 'Хатлон', 'Согд', 'ГБАО'].map((region, index) => ({
          values: { code: `R-${run}-${index}`, region },
        })),
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const policy = await request.post(`/api/v1/datasets/${datasetId}/policies/rows`, {
      headers,
      data: {
        principal: { type: 'user', id: managerId },
        filter: { field: 'region', op: 'eq', value: 'Хатлон' },
        note: 'Только своя область',
      },
    })
    expect(policy.ok(), await policy.text()).toBeTruthy()

    // График «число по областям» на дашборде
    const chart = await request.post('/api/v1/charts', {
      headers,
      data: {
        name: `По областям ${run}`,
        spaceId: space?.id,
        spec: {
          version: 1,
          type: 'bar',
          data: {
            query: {
              version: 1,
              source: { kind: 'dataset', id: datasetId },
              steps: [
                {
                  type: 'aggregate',
                  groupBy: [{ field: 'region' }],
                  measures: [{ alias: 'n', agg: 'count' }],
                },
                { type: 'sort', by: [{ field: 'region', dir: 'asc' }] },
              ],
            },
          },
          encoding: {
            x: { field: 'region', type: 'nominal' },
            y: [{ field: 'n', type: 'quantitative' }],
          },
        },
      },
    })
    expect(chart.ok(), await chart.text()).toBeTruthy()
    const dashboard = await request.post('/api/v1/dashboards', {
      headers,
      data: {
        name: `Сводка руководителя ${run}`,
        spaceId: space?.id,
        spec: {
          tiles: [
            {
              id: 't1',
              kind: 'chart',
              chartId: (await chart.json()).id,
              title: 'По областям',
              x: 0,
              y: 0,
              w: 6,
              h: 4,
            },
          ],
        },
      },
    })
    expect(dashboard.ok(), await dashboard.text()).toBeTruthy()
    const dashboardId = (await dashboard.json()).id as string

    // Администратор видит все три области
    const full = await request.post(`/api/v1/dashboards/${dashboardId}/data`, {
      headers,
      data: { filters: {} },
    })
    expect(full.ok(), await full.text()).toBeTruthy()
    expect((await full.json()).tiles.t1.result.rows).toHaveLength(3)

    // Руководитель — в своём браузере
    const context = await browser.newContext({ baseURL, acceptDownloads: true })
    const login = await context.request.post('/api/v1/auth/login', {
      data: { login: MANAGER_LOGIN, password: MANAGER_PASSWORD, rememberDevice: false },
    })
    expect(login.ok(), await login.text()).toBeTruthy()
    const page = await context.newPage()

    // Дашборд: числа отличаются — только своя область
    await page.goto(`/o/${dashboardId}`)
    await page.getByRole('button', { name: 'Таблица данных' }).click()
    await expect(page.getByRole('rowheader', { name: 'Хатлон', exact: true })).toBeVisible()
    await expect(page.getByRole('rowheader', { name: 'Согд', exact: true })).toHaveCount(0)
    await expect(page.getByRole('rowheader', { name: 'ГБАО', exact: true })).toHaveCount(0)

    // Экспорт CSV — только строки руководителя
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Экспорт' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: 'CSV' }).click()
    await dialog.getByRole('button', { name: 'Выгрузить' }).click()
    await expect(dialog.getByText('Готово: 2 строки.')).toBeVisible({ timeout: 30_000 })
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Скачать' }).click(),
    ])
    const csv = await readFile(await download.path(), 'utf8')
    const lines = csv.trim().split(/\r\n/)
    expect(lines).toHaveLength(3)
    expect(lines.slice(1).every((line) => line.includes('Хатлон'))).toBe(true)
    expect(csv).not.toContain('Согд')
    await page.keyboard.press('Escape')

    // SQL-лаборатория — те же политики; системные таблицы отклоняются
    await page.goto('/sql')
    await page.locator('[data-sql-editor-state="ready"]').waitFor({ timeout: 20_000 })
    const editor = page.getByRole('textbox', { name: 'Запрос SQL' })
    const runQuery = async (text: string) => {
      await editor.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.insertText(text)
      await page.getByRole('button', { name: 'Выполнить' }).click()
    }
    await runQuery(`SELECT Область, count(*) AS n FROM "${name}" GROUP BY Область`)
    const result = page.getByRole('grid', { name: 'Результат запроса' })
    await expect(result.getByRole('gridcell', { name: 'Хатлон', exact: true })).toBeVisible()
    await expect(result.getByRole('gridcell', { name: 'Согд', exact: true })).toHaveCount(0)

    await runQuery('SELECT * FROM public.users')
    await expect(page.getByText(/Обращение к схеме «public» запрещено/).first()).toBeVisible()

    await context.close()
  })
})
