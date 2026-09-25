import type { APIRequestContext } from '@playwright/test'
import { createServiceAccount, expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Решения владельца по платформе (05-risks §5): адресаты правил автоматизации в политике
 * безопасности (N38, ADR-0141), флажок «Срочное» у уведомления правила (N23, ADR-0140) и
 * предупреждение читателю о просроченном пересмотре регламента (N35).
 */

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await (await request.get('/api/v1/me')).json()
  return { 'x-csrf-token': me.session.csrfToken as string }
}

test.describe('Решения владельца: платформа', () => {
  test('«Безопасность»: адресаты правил сохраняются в виде домена', async ({ page, request }) => {
    const headers = await csrf(request)
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Безопасность' }).click()

    const card = page.getByText('Адресаты правил автоматизации').first()
    await expect(card).toBeVisible()
    await page.getByLabel('Почтовые домены').fill('@Kchs.TJ\nmchs.gov.ru')
    await page.getByLabel('Домены вебхуков').fill('https://Hooks.Partner.tj/in')
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Политика безопасности сохранена')).toBeVisible()
    await expect(page.getByLabel('Почтовые домены')).toHaveValue('kchs.tj\nmchs.gov.ru')
    await expect(page.getByLabel('Домены вебхуков')).toHaveValue('hooks.partner.tj')

    const restored = await request.patch('/api/v1/admin/security-policy', {
      headers,
      data: { ruleEmailDomains: [], ruleWebhookDomains: [] },
    })
    expect(restored.ok(), await restored.text()).toBeTruthy()
  })

  test('уведомление правила отмечается срочным', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const headers = await csrf(request)
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
    const robot = await createServiceAccount(request, `Робот срочных ${run}`, [
      { spaceId, role: 'editor' },
    ])
    const name = `Срочный доклад ${run}`
    const created = await request.post('/api/v1/automation/rules', {
      headers,
      data: {
        spaceId,
        definition: {
          name: { ru: name },
          runAs: robot.id,
          enabled: false,
          trigger: { kind: 'event', type: 'object.created', filter: { 'object.type': 'folder' } },
          conditions: { expr: "contains(object.title, 'Срочный')" },
          actions: [
            { type: 'notify', to: ['role:system_admin'], text: 'Доклад', channels: ['app'] },
          ],
        },
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const ruleId = (await created.json()).id as string

    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Правила автоматизации' }).click()
    await page.getByRole('row', { name: new RegExp(name) }).click()
    await expect(page.getByRole('tab', { name })).toBeVisible()
    const urgent = page.getByRole('switch', {
      name: 'Срочное — сквозь тихие часы и «не беспокоить»',
    })
    await expect(urgent).toBeVisible({ timeout: 20_000 })
    await expect(urgent).not.toBeChecked()
    await urgent.click()
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Правило сохранено')).toBeVisible()

    const saved = await (await request.get(`/api/v1/automation/rules/${ruleId}`)).json()
    expect(saved.definition.actions[0].urgent).toBe(true)
    await request.delete(`/api/v1/objects/${ruleId}`, { headers })
  })

  test('регламент с просроченным пересмотром предупреждает читателя', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const headers = await csrf(request)
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id as string
    const created = await request.post('/api/v1/pages', {
      headers,
      data: { title: `Регламент связи ${run}`, spaceId, template: 'regulation' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const pageId = (await created.json()).id as string
    const published = await request.post(`/api/v1/pages/${pageId}/publish`, {
      headers,
      data: { note: null },
    })
    expect(published.ok(), await published.text()).toBeTruthy()
    // Срок пересмотра по умолчанию — год от публикации
    expect((await published.json()).reviewAt).toBeTruthy()

    const past = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10)
    const overdue = await request.patch(`/api/v1/pages/${pageId}`, {
      headers,
      data: { reviewAt: past },
    })
    expect(overdue.ok(), await overdue.text()).toBeTruthy()

    await openWorkspace(page, request)
    await page.goto(`/o/${pageId}`)
    await expect(page.getByText(/Срок пересмотра прошёл .* текст мог устареть/)).toBeVisible({
      timeout: 20_000,
    })
    await request.delete(`/api/v1/objects/${pageId}`, { headers })
  })
})
