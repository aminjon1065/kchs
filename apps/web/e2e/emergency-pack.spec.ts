import type { APIRequestContext, Browser } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openScreen, openWorkspace, test } from './fixtures.js'

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const PASSWORD = process.env.SEED_USER_PASSWORD || 'Kchs!Work-2026-3v'
const NOT_INSTALLED = 'пакет ЧС не установлен: pnpm db:seed --pack=emergency'

/**
 * Приёмка предметного пакета «Чрезвычайные ситуации» (P5-E08, ADR-0128;
 * 04-verification.md §3, фаза 5, п. 6) на демо-стенде с установленным пакетом:
 * ситуационный экран; сообщение об опасном явлении → уведомление дежурной смене;
 * суточная сводка регионального управления → реестр происшествий → уведомление
 * руководству и поручение оперативному управлению. Сотрудник e2e (`user001`) —
 * председатель: он в группе «Руководство штаба ЧС».
 */

const plain = (title: string) => title.replace(/<\/?mark>/g, '')

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await (await request.get('/api/v1/me')).json()
  return { 'x-csrf-token': me.session.csrfToken as string }
}

/** Объект пакета по точному названию — через поиск, как его нашёл бы человек. */
async function packObject(request: APIRequestContext, type: string, title: string) {
  const response = await request.get(
    `/api/v1/search?q=${encodeURIComponent(title)}&types=${type}&limit=20`,
  )
  expect(response.ok(), await response.text()).toBeTruthy()
  const hit = ((await response.json()).hits as Array<{ objectId: string; title: string }>).find(
    (item) => plain(item.title) === title,
  )
  expect(hit, `${title}: ${NOT_INSTALLED}`).toBeTruthy()
  return hit?.objectId as string
}

async function unitId(request: APIRequestContext, code: string): Promise<string> {
  const units = (await (await request.get('/api/v1/org/units')).json()).items as Array<{
    id: string
    code: string
  }>
  const unit = units.find((item) => item.code === code)
  expect(unit, `подразделение ${code}`).toBeTruthy()
  return unit?.id as string
}

async function territoryId(request: APIRequestContext, name: string): Promise<string> {
  const items = (await (await request.get('/api/v1/territories')).json()).items as Array<{
    id: string
    level: string
    name: { ru: string }
  }>
  const found = items.find((item) => item.level === 'district' && item.name.ru === name)
  expect(found, `район ${name}`).toBeTruthy()
  return found?.id as string
}

/** Сотрудник в своём браузере: отдельный контекст и чистое рабочее пространство. */
async function signIn(browser: Browser, login: string) {
  const context = await browser.newContext({ baseURL: BASE })
  const response = await context.request.post('/api/v1/auth/login', {
    data: { login, password: PASSWORD, rememberDevice: false },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const page = await context.newPage()
  await openWorkspace(page, context.request)
  return { context, page }
}

async function loginOf(request: APIRequestContext, unit: string, userId: string) {
  const users = (await (await request.get(`/api/v1/users?unitId=${unit}&limit=100`)).json())
    .items as Array<{ id: string; login: string }>
  const user = users.find((item) => item.id === userId)
  expect(user, `сотрудник ${userId}`).toBeTruthy()
  return user?.login as string
}

/** Завершённые запуски правила пакета по ключу — через список правил пространства. */
async function ruleRuns(request: APIRequestContext, spaceId: string, key: string) {
  const rules = (await (await request.get(`/api/v1/automation/rules?spaceId=${spaceId}`)).json())
    .items as Array<{ id: string; key: string }>
  const rule = rules.find((item) => item.key === key)
  expect(rule, `правило ${key}: ${NOT_INSTALLED}`).toBeTruthy()
  const runs = await request.get(`/api/v1/automation/rules/${rule?.id}/runs`)
  return (await runs.json()).items as Array<{
    status: string
    error: string | null
    steps: Array<{ status: string; objectId: string | null }>
    createdAt: string
  }>
}

test.describe('Пакет ЧС: приёмка', () => {
  test('ситуационный экран: показатели, карта обстановки, происшествия и опасные явления', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000)
    await packObject(request, 'dashboard', 'Ситуационный экран')
    await openWorkspace(page, request)
    // Тайлы слоёв карты обстановки: ответ ждётся ещё до открытия экрана
    const tiles = page.waitForResponse(
      (response) => /\/gis\/layers\/[^/]+\/tiles\//.test(response.url()) && response.ok(),
    )
    await openScreen(page, 'Ситуационный экран')

    for (const title of [
      'Происшествия',
      'Превышения уровня воды',
      'Свободно в ПВР',
      'Происшествия за трое суток',
      'Опасные явления за неделю',
      'Дежурная смена сегодня',
    ]) {
      await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 20_000 })
    }
    // Период плитки словами, а не отсчётом единиц («дни: с 0 по 0»)
    await expect(page.getByText('Сегодня', { exact: true }).first()).toBeVisible()
    await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({ timeout: 20_000 })
    await tiles
    await page.screenshot({ path: testInfo.outputPath('situation.png'), fullPage: true })

    // TV-режим: экран дежурной смены на весь монитор, крупные плитки, выход по Esc
    await page.getByRole('button', { name: 'TV' }).click()
    await expect(page.getByText('Опасные явления за неделю').first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('situation-tv.png') })
    await page.keyboard.press('Escape')
  })

  test('сообщение об опасном явлении в стране → уведомление дежурной смене', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const headers = await csrf(request)
    const title = `Проверка ленты ${run}: толчок M4,7 в Мургабе`
    const datasetId = await packObject(request, 'dataset', 'Сообщения об опасных явлениях')

    // Свежий толчок: ключ повтора — десятиминутка времени, поэтому время прогона своё
    const occurred = new Date(Date.now() - (5 + Math.floor(Math.random() * 1200)) * 60_000)
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: [
          {
            values: {
              code: `e2e:${run}`,
              source: 'geophysics',
              hazard: 'earthquake',
              title,
              occurred_at: occurred.toISOString(),
              magnitude: 4.7,
              territory: await territoryId(request, 'Мургаб'),
              geometry: { type: 'Point', coordinates: [73.97, 38.17] },
            },
          },
        ],
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const rowId = (await inserted.json()).items[0]._id as string

    // Дежурный — сотрудник оперативно-дежурной службы, не её начальник
    const duty = await unitId(request, 'UO-DUTY')
    const staff = (await (await request.get(`/api/v1/users?unitId=${duty}&limit=100`)).json())
      .items as Array<{ login: string }>
    const officer = staff.map((item) => item.login).sort()[1]
    expect(officer, 'сотрудник дежурной службы').toBeTruthy()
    const { context, page } = await signIn(browser, officer as string)
    try {
      await openScreen(page, 'Уведомления')
      await expect(async () => {
        await page.reload()
        await expect(page.getByText(title).first()).toBeVisible({ timeout: 3_000 })
      }).toPass({ timeout: 45_000 })
    } finally {
      await context.close()
      await request.post(`/api/v1/datasets/${datasetId}/rows/delete`, {
        headers,
        data: { ids: [rowId] },
      })
    }
  })

  test('суточная сводка региона → реестр происшествий → руководству и поручение', async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const headers = await csrf(request)
    const description = `Пожар в общежитии ${run}`
    const formId = await packObject(request, 'form', 'Суточная сводка регионального управления')
    const incidentsId = await packObject(request, 'dataset', 'Происшествия')

    // Сводку Согдийского управления сдаёт назначенный ответственный (N48)
    const form = await (await request.get(`/api/v1/forms/${formId}`)).json()
    const sughd = await unitId(request, 'RG-SUG')
    const assignment = (
      form.definition.assignments as Array<{ id: string; responsibleId: string | null }>
    ).find((item) => item.id === sughd)
    expect(assignment?.responsibleId, 'ответственный за сводку Согдийского управления').toBeTruthy()
    const operator = await loginOf(request, sughd, assignment?.responsibleId as string)

    const { context, page } = await signIn(browser, operator)
    let rowIds: string[] = []
    try {
      await page.goto(`/o/${formId}`)
      await page.getByRole('combobox', { name: 'Период' }).click()
      await page.getByRole('option').first().click()
      await page.getByRole('button', { name: 'Открыть период' }).click()
      // Возвращённая прошлым прогоном сводка открывается со своими строками
      const table = page.getByRole('table', { name: 'Строки сводки' })
      const add = page.getByRole('button', { name: 'Добавить строку' })
      await expect(add).toBeVisible({ timeout: 20_000 })
      while (await page.getByRole('button', { name: 'Удалить строку 1' }).isVisible()) {
        await page.getByRole('button', { name: 'Удалить строку 1' }).click()
      }
      await add.click()

      await table.getByLabel('Дата и время, строка 1').fill('2026-09-24T14:30')
      await table.getByRole('button', { name: 'Тип, строка 1' }).click()
      await page.getByRole('button', { name: 'Пожар в здании' }).click()
      await table.getByRole('button', { name: 'Территория, строка 1' }).click()
      await page.getByRole('searchbox', { name: 'Найти территорию' }).fill('Худжанд')
      await page
        .getByRole('list', { name: 'Найденные территории' })
        .getByRole('button', { name: /^Худжанд/ })
        .first()
        .click()
      await table.getByLabel('Пострадавшие, строка 1').fill('2')
      await table.getByLabel('Погибшие, строка 1').fill('1')
      await table.getByLabel('Описание, строка 1').fill(description)
      await page.getByRole('button', { name: 'Сдать сводку' }).click()
      await expect(page.getByText('Сводка сдана')).toBeVisible({ timeout: 20_000 })

      // Строка в реестре: подразделение, дата сводки и автор проставлены сами
      const query = await request.post(`/api/v1/datasets/${incidentsId}/rows/query`, {
        headers,
        data: {
          where: { field: 'description', op: 'eq', value: description },
          limit: 10,
          count: false,
        },
      })
      expect(query.ok(), await query.text()).toBeTruthy()
      const result = (await query.json()) as { fields: Array<{ name: string }>; rows: unknown[][] }
      const rows = result.rows.map((row) =>
        Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]])),
      )
      expect(rows).toHaveLength(1)
      rowIds = rows.map((row) => String(row._id))
      expect(rows[0]).toMatchObject({
        deaths: 1,
        injured: 2,
        type_code: 'FIRE',
        unit: sughd,
        reported_by: assignment?.responsibleId,
      })
      expect(rows[0]?.report_date).toBeTruthy()

      // Правило «Происшествие с погибшими»: председатель видит уведомление…
      const chairman = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
      const chairmanPage = await chairman.newPage()
      try {
        await openWorkspace(chairmanPage, chairman.request)
        await openScreen(chairmanPage, 'Уведомления')
        await expect(async () => {
          await chairmanPage.reload()
          await expect(chairmanPage.getByText(description).first()).toBeVisible({ timeout: 3_000 })
        }).toPass({ timeout: 45_000 })
      } finally {
        await chairman.close()
      }

      // …а поручение оперативному управлению создано тем же запуском
      const runs = await ruleRuns(request, form.spaceId as string, 'emergency-incident-deaths')
      const latest = runs.find((item) => item.status === 'succeeded')
      expect(latest, JSON.stringify(runs.slice(0, 3))).toBeTruthy()
      const task = latest?.steps.at(-1)
      expect(task?.status).toBe('ok')
      if (task?.objectId) {
        await request.delete(`/api/v1/objects/${task.objectId}`, { headers })
      }
    } finally {
      await context.close()
      // Уборка: сводка возвращается (прогон повторяем), строки уходят из реестра
      const control = await (await request.get(`/api/v1/forms/${formId}/control?periods=7`)).json()
      const row = (
        control.rows as Array<{
          subject: { id: string }
          cells: Array<{ state: string; submissionId: string | null }>
        }>
      ).find((item) => item.subject.id === sughd)
      for (const cell of row?.cells ?? []) {
        if (cell.state !== 'submitted' || !cell.submissionId) continue
        await request.post(`/api/v1/forms/submissions/${cell.submissionId}/review`, {
          headers,
          data: { decision: 'return', comment: 'Проверочный прогон e2e' },
        })
      }
      if (rowIds.length > 0) {
        await request.post(`/api/v1/datasets/${incidentsId}/rows/delete`, {
          headers,
          data: { ids: rowIds },
        })
      }
    }
  })
})
