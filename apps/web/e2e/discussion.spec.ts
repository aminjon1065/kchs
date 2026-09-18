import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Обсуждение (P0-E08): вложение в сообщении открывается во вкладке, реакция
 * ставится и снимается; читатель без права писать не видит поля и реакций.
 */
test('обсуждение: вложение в сообщении, реакция, читатель только читает', async ({
  page,
  request,
  browser,
}) => {
  const run = Date.now().toString(36)
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const space = await request.post('/api/v1/spaces', {
    headers,
    data: { key: `talk-${run}`, name: `Обсуждение ${run}` },
  })
  expect(space.ok(), await space.text()).toBeTruthy()
  const spaceId = (await space.json()).id as string
  const folder = await request.post('/api/v1/folders', {
    headers,
    data: { name: `Донесения ${run}`, spaceId },
  })
  const folderId = (await folder.json()).id as string
  const users = await request.get('/api/v1/users?q=user001')
  const reader = (await users.json()).items[0] as { id: string }
  await request.post(`/api/v1/spaces/${spaceId}/members`, {
    headers,
    data: { userId: reader.id, role: 'viewer' },
  })

  await openWorkspace(page, request)
  await page.goto(`/o/${folderId}`)
  await page.getByRole('button', { name: 'Обсуждение', exact: true }).click()

  // Вложение: скрепка → файл загружается → уходит вместе с текстом
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-talk-'))
  const fileName = `schema-${run}.txt`
  writeFileSync(path.join(dir, fileName), 'Схема эвакуации: выход через северный подъезд\n')
  const composer = page.locator('form').filter({ has: page.getByLabel('Оставьте комментарий…') })
  await composer.locator('input[type="file"]').setInputFiles(path.join(dir, fileName))
  await expect(page.getByRole('list', { name: 'Вложения сообщения' })).toContainText(fileName)
  await page.getByLabel('Оставьте комментарий…').fill('Схема во вложении')
  await page.getByRole('button', { name: 'Отправить' }).click()

  const message = page.getByRole('article').filter({ hasText: 'Схема во вложении' })
  await expect(message.getByRole('button', { name: new RegExp(fileName) })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Вложения сообщения' })).toHaveCount(0)

  // Реакция: поставить через выбор и снять нажатием на счётчик
  await message.hover()
  await message.getByRole('button', { name: 'Добавить реакцию' }).click()
  await page.getByRole('button', { name: 'Реакция 👍' }).click()
  const thumbs = message.getByRole('button', { name: '👍 — 1' })
  await expect(thumbs).toHaveAttribute('aria-pressed', 'true')
  await thumbs.click()
  await expect(message.getByRole('button', { name: /👍/ })).toHaveCount(0)

  // Вложение открывается во вкладке
  await message.getByRole('button', { name: new RegExp(fileName) }).click()
  await expect(page.getByRole('tab', { name: new RegExp(fileName) })).toBeVisible()

  // Читатель видит сообщение и вложение, но не пишет и не реагирует
  const readerContext = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(readerContext.request)
  const readerPage = await readerContext.newPage()
  await readerPage.goto(`/o/${folderId}`)
  await readerPage.getByRole('button', { name: 'Обсуждение', exact: true }).click()
  const seen = readerPage.getByRole('article').filter({ hasText: 'Схема во вложении' })
  await expect(seen.getByRole('button', { name: new RegExp(fileName) })).toBeVisible()
  await expect(readerPage.getByLabel('Оставьте комментарий…')).toHaveCount(0)
  await expect(seen.getByRole('button', { name: 'Добавить реакцию' })).toHaveCount(0)
  await readerContext.close()
})
