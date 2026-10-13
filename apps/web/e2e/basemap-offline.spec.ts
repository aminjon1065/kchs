import type { APIRequestContext, Page } from '@playwright/test'
import { createServiceAccount, expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Карта района без сети (ADR-0211): сотрудник скачивает подложку Варзобского района в
 * окне поля-точки сводки; связь пропала — на собранном приложении страница ещё и
 * перезагружается из служебного потока (ADR-0207) — и окно точки показывает район:
 * карта переходит к местоположению, и ни одного запроса к архиву подложки в сеть.
 * Нужна векторная подложка установки (infra/basemaps/build-pmtiles.sh), иначе пропуск.
 */

/** Варзоб: центр района справочника. */
const VARZOB = { latitude: 38.9, longitude: 68.8 }

async function pointForm(request: APIRequestContext, run: string) {
  const me = await (await request.get('/api/v1/me')).json()
  const headers = { 'x-csrf-token': me.session.csrfToken as string }
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
  const dataset = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: `Осмотр района ${run}`,
      spaceId,
      fields: [
        { key: 'note', label: { ru: 'Что видно' }, type: 'text' },
        { key: 'place', label: { ru: 'Место осмотра' }, type: 'geometry' },
      ],
    },
  })
  expect(dataset.ok(), await dataset.text()).toBeTruthy()
  const datasetId = (await dataset.json()).id as string
  const writer = await createServiceAccount(request, `Осмотр района ${run}`, [
    { spaceId, role: 'editor' },
  ])
  const name = `Осмотр района без сети ${run}`
  const form = await request.post('/api/v1/forms', {
    headers,
    data: {
      name,
      spaceId,
      runAs: writer.id,
      definition: {
        datasetId,
        fields: [{ key: 'note' }, { key: 'place' }],
        schedule: { periodicity: 'daily', time: '08:00', dueMode: 'calendar', dueWorkingDays: 1 },
        assignments: [{ kind: 'user', id: me.user.id as string }],
        review: { enabled: false, reviewers: [] },
      },
    },
  })
  expect(form.ok(), await form.text()).toBeTruthy()
  const formId = (await form.json()).id as string
  const enabled = await request.post(`/api/v1/forms/${formId}/enabled`, {
    headers,
    data: { enabled: true },
  })
  expect(enabled.ok(), await enabled.text()).toBeTruthy()
  return { headers, formId, name }
}

async function openPeriod(page: Page, name: string) {
  await openScreen(page, 'Формы сбора')
  await page.getByRole('row', { name: new RegExp(name) }).click()
  await page.getByRole('combobox', { name: 'Период' }).click()
  await page.getByRole('option').first().click()
  await page.getByRole('button', { name: 'Открыть период' }).click()
  await expect(page.getByRole('button', { name: 'Место осмотра' })).toBeVisible()
}

const pointMap = (page: Page) => page.getByRole('dialog', { name: 'Место на карте' })

test.describe('Карта района без сети', () => {
  test('район на устройстве: окно точки без сети рисует подложку с устройства', async ({
    page,
    request,
    context,
  }) => {
    test.setTimeout(240_000)
    const basemaps = (await (await request.get('/api/v1/gis/basemaps')).json()).items as Array<{
      kind: string
    }>
    test.skip(
      !basemaps.some((item) => item.kind === 'vector'),
      'нет векторной подложки установки (infra/basemaps/build-pmtiles.sh)',
    )
    const dev = await request.get('/@vite/client')
    const viteDev = dev.ok() && (dev.headers()['content-type'] ?? '').includes('javascript')
    await context.grantPermissions(['geolocation'])
    await context.setGeolocation(VARZOB)
    // Без анимации перехода: на промежуточных масштабах перелёта видна местность вне района,
    // и её тайлы честно шли бы в сеть
    await page.emulateMedia({ reducedMotion: 'reduce' })

    const run = Date.now().toString(36)
    const form = await pointForm(request, run)
    await openWorkspace(page, request)
    if (!viteDev) {
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
        timeout: 30_000,
      })
    }
    await openPeriod(page, form.name)

    // Скачать Варзоб из окна точки: подложка → «Карта района без сети»
    await page.getByRole('button', { name: 'Место осмотра' }).click()
    await expect(pointMap(page).locator('[data-map-state="idle"]')).toBeVisible({ timeout: 30_000 })
    await pointMap(page).getByRole('button', { name: 'Подложка карты' }).click()
    await page.getByRole('button', { name: 'Карта района без сети' }).click()
    const offline = page.getByRole('dialog', { name: 'Карта района без сети' })
    await offline.getByRole('button', { name: 'Выберите район' }).click()
    await page.getByRole('searchbox', { name: 'Найти территорию' }).fill('Варзоб')
    await page
      .getByRole('list', { name: 'Найденные территории' })
      .getByRole('button', { name: /Варзоб/ })
      .click()
    await expect(offline.getByTestId('offline-estimate')).toBeVisible({ timeout: 60_000 })
    await offline.getByRole('button', { name: 'Скачать' }).click()
    await expect(page.getByText('Карта района на устройстве')).toBeVisible({ timeout: 120_000 })
    await expect(offline.getByRole('list', { name: 'На устройстве' })).toContainText('Варзоб')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(pointMap(page)).toBeHidden()

    // Связь пропала; на сборке — ещё и перезагрузка страницы без сети
    const archive: string[] = []
    page.on('request', (item) => {
      if (item.url().includes('/pmtiles/'))
        archive.push(`${item.url().split('/').pop()} ${item.headers().range ?? ''}`)
    })
    await context.setOffline(true)
    if (!viteDev) {
      // Служебный поток подготовил экраны сводок через 5 с после входа
      await page.waitForTimeout(3_000)
      await page.reload()
      await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
      await openPeriod(page, form.name)
    }
    await page.getByRole('button', { name: 'Место осмотра' }).click()
    await expect(pointMap(page).locator('[data-map-state="idle"]')).toBeVisible({ timeout: 30_000 })
    // Обзор страны района не покрывает — его тайлы и шли в сеть; дальше считаем заново
    archive.length = 0
    await pointMap(page).getByRole('button', { name: 'Моё местоположение' }).click()
    await expect(pointMap(page).getByLabel('Широта')).toHaveValue('38.90000')
    await page.waitForTimeout(1_500)
    await expect(pointMap(page).locator('[data-map-state="idle"]')).toBeVisible({ timeout: 30_000 })
    expect(archive, 'тайлы района — с устройства, без сети').toEqual([])

    await context.setOffline(false)
    await request.delete(`/api/v1/objects/${form.formId}`, { headers: form.headers })
  })
})
