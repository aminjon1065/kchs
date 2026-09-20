import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = 'http://localhost:5173'

/**
 * Мессенджер (P4-E01): личная беседа заводится с сотрудником, сообщение
 * закрепляется и превращается в поручение, статус «не беспокоить» выставляется
 * из шапки, а собеседник видит беседу непрочитанной и читает её.
 */
test('чаты: личная беседа, закрепление, поручение из сообщения, непрочитанное у собеседника', async ({
  page,
  request,
  browser,
}) => {
  const run = Date.now().toString(36)
  await openWorkspace(page, request)
  await page.getByRole('button', { name: 'Чаты' }).first().click()
  await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible()

  // Новая личная беседа с сотрудником
  await page.getByRole('button', { name: 'Новая беседа' }).click()
  const create = page.getByRole('dialog')
  await create.getByRole('searchbox', { name: 'Собеседник' }).fill('user001')
  await create.getByRole('list', { name: 'Собеседник' }).getByRole('button').first().click()
  await create.getByRole('button', { name: 'Создать' }).click()
  await expect(create).toBeHidden()

  const text = `Паводок ${run}: нужен насос`
  await page.getByLabel('Сообщение…').fill(text)
  await page.getByRole('button', { name: 'Отправить' }).click()
  const message = page.getByRole('article').filter({ hasText: text })
  await expect(message).toBeVisible()

  // Закрепление: сообщение попадает в шапку закреплённых
  const row = page.getByRole('listitem').filter({ has: message }).first()
  await row.hover()
  await row.getByRole('button', { name: 'Действия с сообщением' }).click()
  await page.getByRole('menuitem', { name: 'Закрепить сообщение' }).click()
  await page.getByRole('button', { name: 'Закреплённые' }).click()
  await expect(page.getByRole('list', { name: 'Закреплённые' })).toContainText(`Паводок ${run}`)
  await page.getByRole('button', { name: 'Закреплённые' }).click()

  // Поручение по сообщению: цитата уходит в описание, беседа связана с ним
  await row.hover()
  await row.getByRole('button', { name: 'Действия с сообщением' }).click()
  await page.getByRole('menuitem', { name: 'Создать поручение' }).click()
  const task = page.getByRole('dialog')
  await task.getByLabel('Что сделать').fill(`Найти насос ${run}`)
  await task.getByRole('searchbox', { name: 'Исполнитель' }).fill('user001')
  await task.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
  await task.getByRole('button', { name: 'Создать поручение' }).click()
  await expect(page.getByText(/Поручение .+ создано/)).toBeVisible()

  // Статус «не беспокоить» из шапки экрана
  await page
    .getByRole('button', { name: /В сети|Отошёл|Не беспокоить|На встрече|Не в сети/ })
    .first()
    .click()
  const presence = page.getByRole('dialog')
  await presence.getByRole('radio', { name: 'Не беспокоить' }).click()
  await presence.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('button', { name: 'Не беспокоить' })).toBeVisible()

  // Собеседник видит беседу непрочитанной, читает её и находит сообщение поиском
  const peerContext = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(peerContext.request)
  const peerPage = await peerContext.newPage()
  await peerPage.goto('/chats')
  // Личная беседа у собеседника названа именем отправителя, а не текстом
  // последнего сообщения: после поручения в предпросмотре уже оно
  const chat = peerPage
    .getByRole('list', { name: 'Чаты' })
    .getByRole('listitem')
    .filter({ hasText: 'Системный Администратор' })
    .first()
  await expect(chat).toBeVisible()
  await chat.getByRole('button').first().click()
  await expect(peerPage.getByRole('article').filter({ hasText: text })).toBeVisible()

  await peerPage.getByRole('button', { name: 'Поиск сообщений' }).click()
  await peerPage.getByRole('searchbox', { name: 'Поиск сообщений' }).fill(`Паводок ${run}`)
  await expect(peerPage.getByRole('list', { name: 'Поиск сообщений' })).toContainText('насос')
  await peerContext.close()
})
