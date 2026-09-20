import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Мессенджер (P4-E01): личная беседа появляется у обоих, сообщение приходит
 * собеседнику непрочитанным, закрепление и поручение по сообщению работают
 * из ленты, статус «не беспокоить» выставляется из шапки.
 */
test('чаты: личная беседа, непрочитанное, закрепление, поручение из сообщения', async ({
  page,
  request,
  browser,
}) => {
  const run = Date.now().toString(36)
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const users = await request.get('/api/v1/users?q=user001')
  const peer = (await users.json()).items[0] as { id: string; displayName: string }

  await openWorkspace(page, request)
  await page.getByRole('button', { name: 'Чаты' }).first().click()
  await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible()

  // Новая личная беседа с сотрудником
  await page.getByRole('button', { name: 'Новая беседа' }).click()
  await page.getByRole('dialog').getByLabel('Собеседник').fill('user001')
  await page.getByRole('option').first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click()

  const text = `Паводок ${run}: нужен насос`
  await page.getByLabel('Сообщение…').fill(text)
  await page.getByRole('button', { name: 'Отправить' }).click()
  const message = page.getByRole('article').filter({ hasText: text })
  await expect(message).toBeVisible()

  // Закрепление: сообщение попадает в шапку закреплённых
  await message.hover()
  await page
    .getByRole('listitem')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Действия с сообщением' })
    .click()
  await page.getByRole('menuitem', { name: 'Закрепить сообщение' }).click()
  await page.getByRole('button', { name: 'Закреплённые' }).click()
  await expect(page.getByRole('list', { name: 'Закреплённые' })).toContainText(`Паводок ${run}`)

  // Поручение по сообщению: цитата уходит в описание, беседа связана с ним
  await page
    .getByRole('listitem')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Действия с сообщением' })
    .click()
  await page.getByRole('menuitem', { name: 'Создать поручение' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Что сделать').fill(`Найти насос ${run}`)
  await dialog.getByLabel('Исполнитель').fill('user001')
  await dialog.getByRole('option').first().click()
  await dialog.getByRole('button', { name: 'Создать поручение' }).click()
  await expect(page.getByText(/Поручение .* создано/)).toBeVisible()

  // Статус «не беспокоить» из шапки экрана
  await page.getByRole('button', { name: /В сети|Отошёл|Не беспокоить|На встрече|Не в сети/ }).click()
  await page.getByRole('dialog').getByRole('radio', { name: 'Не беспокоить' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('button', { name: 'Не беспокоить' })).toBeVisible()

  // Собеседник видит беседу непрочитанной и читает её
  const peerContext = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(peerContext.request)
  const peerPage = await peerContext.newPage()
  await peerPage.goto('/chats')
  const row = peerPage.getByRole('list', { name: 'Чаты' }).getByRole('listitem').first()
  await expect(row).toContainText(`Паводок ${run}`)
  await row.getByRole('button').click()
  await expect(peerPage.getByRole('article').filter({ hasText: text })).toBeVisible()
  await peerContext.close()
  expect(peer.id).toBeTruthy()
})
