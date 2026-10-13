import type { APIRequestContext } from '@playwright/test'
import { createServiceAccount, expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Сводка без сети (ADR-0204, ADR-0207, ADR-0208): связь пропала после открытия
 * периода — сотрудник заполняет сводку и фотографирует, сдача ложится в очередь
 * устройства; связь вернулась — снимок уходит на сервер, сводка сдаётся с файлом.
 * Холодный старт без сети проверяется только на собранном приложении (профиль `app`,
 * Caddy): на сервере разработки Vite страница грузит исходники, а не сборку.
 */

/** PNG 1×1: устройство пережмёт его в JPEG, как снимок камеры. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function photoForm(request: APIRequestContext, run: string) {
  const me = await request.get('/api/v1/me')
  const profile = await me.json()
  const headers = { 'x-csrf-token': profile.session.csrfToken as string }
  const userId = profile.user.id as string
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
  const dataset = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: `Осмотр моста ${run}`,
      spaceId,
      fields: [
        { key: 'note', label: { ru: 'Что видно' }, type: 'text' },
        { key: 'photo', label: { ru: 'Снимок места' }, type: 'file' },
      ],
    },
  })
  expect(dataset.ok(), await dataset.text()).toBeTruthy()
  const datasetId = (await dataset.json()).id as string
  const writer = await createServiceAccount(request, `Осмотр ${run}`, [{ spaceId, role: 'editor' }])
  const form = await request.post('/api/v1/forms', {
    headers,
    data: {
      name: `Осмотр без сети ${run}`,
      spaceId,
      runAs: writer.id,
      definition: {
        datasetId,
        fields: [
          { key: 'note', required: true },
          { key: 'photo', required: true },
        ],
        schedule: { periodicity: 'daily', time: '08:00', dueMode: 'calendar', dueWorkingDays: 1 },
        assignments: [{ kind: 'user', id: userId }],
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
  return { headers, formId, datasetId, name: `Осмотр без сети ${run}` }
}

test.describe('Сводка без сети', () => {
  test('связь пропала: сводка с фото ждёт на устройстве и сдаётся сама', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const form = await photoForm(request, run)

    await openWorkspace(page, request)
    await openScreen(page, 'Формы сбора')
    await page.getByRole('row', { name: new RegExp(form.name) }).click()
    await page.getByRole('combobox', { name: 'Период' }).click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: 'Открыть период' }).click()
    await expect(page.getByRole('button', { name: 'Добавить фото' })).toBeVisible()

    await page.context().setOffline(true)
    await page.getByLabel('Что видно').fill('Подмыт устой моста')
    // Как человек: кнопка «Добавить фото» открывает выбор файла (камера или галерея)
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Снимок места* Добавить фото' }).click()
    await (await chooser).setFiles({ name: 'мост.png', mimeType: 'image/png', buffer: PIXEL })
    // Снимок на устройстве: миниатюра из IndexedDB, без сервера
    await expect(page.getByRole('img', { name: 'Фото сводки' })).toBeVisible()
    await page.getByRole('button', { name: 'Сдать сводку' }).click()
    await expect(page.getByText('Ждёт отправки')).toBeVisible()

    await page.context().setOffline(false)
    await expect(page.getByText('Сводка из очереди сдана')).toBeVisible({ timeout: 45_000 })

    // На сервере — сдача со снимком: файл JPEG, а не ключ устройства
    const duties = await (await request.get('/api/v1/forms/duties')).json()
    const duty = (
      duties.items as Array<{
        formId: string
        periods: Array<{ submissionId: string | null; state: string }>
      }>
    ).find((item) => item.formId === form.formId)
    const done = duty?.periods.find((period) => period.state === 'accepted')
    expect(done?.submissionId).toBeTruthy()
    const submission = await (
      await request.get(`/api/v1/forms/submissions/${done?.submissionId}`)
    ).json()
    expect(submission.values.note).toBe('Подмыт устой моста')
    const file = await request.get(`/api/v1/files/${submission.values.photo}`)
    expect(file.ok(), await file.text()).toBeTruthy()
    expect((await file.json()).mime).toBe('image/jpeg')

    await request.delete(`/api/v1/objects/${form.formId}`, { headers: form.headers })
  })

  test('холодный старт без сети: оболочка из кэша, вошедший — с устройства', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    // Собранное приложение отдаёт на неизвестный путь страницу SPA, сервер Vite — свой клиент
    const dev = await request.get('/@vite/client')
    const viteDev = dev.ok() && (dev.headers()['content-type'] ?? '').includes('javascript')
    test.skip(viteDev, 'сервер разработки Vite: оболочку из сборки проверяет профиль app')

    await openWorkspace(page, request)
    // Служебный поток взял страницу и подготовил экраны сводок (через 5 с после входа)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 30_000,
    })
    await page.waitForTimeout(8_000)

    await page.context().setOffline(true)
    await page.reload()
    await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
    await openScreen(page, 'Формы сбора')
    await expect(page.getByRole('heading', { name: 'Формы сбора' })).toBeVisible()
    await page.context().setOffline(false)
  })
})
