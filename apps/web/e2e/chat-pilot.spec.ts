import type { Page } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Сообщение…').fill(text)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('article').filter({ hasText: text }).first()).toBeVisible()
}

/** Меню «⋯» сообщения: строка ленты с этим текстом. */
async function messageMenu(page: Page, text: string, item: string): Promise<void> {
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('article').filter({ hasText: text }) })
    .last()
  await row.hover()
  await row.getByRole('button', { name: 'Действия с сообщением' }).last().click()
  await page.getByRole('menuitem', { name: item }).click()
}

/**
 * Чаты до пилота (ADR-0161): отметки «доставлено/прочитано», «печатает»,
 * правка и удаление своего сообщения, выбор и пересылка нескольких, архив у
 * каждого свой с возвратом по новому сообщению.
 */
test('чаты: прочтение, «печатает», правка, удаление, пересылка нескольких и архив', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(120_000)
  const run = Date.now().toString(36)
  await openWorkspace(page, request)
  await page.getByRole('button', { name: 'Чаты' }).first().click()

  // Личная беседа с сотрудником (пара уникальна: повторный прогон откроет ту же)
  await page.getByRole('button', { name: 'Новая беседа' }).click()
  const create = page.getByRole('dialog')
  await create.getByRole('searchbox', { name: 'Собеседник' }).fill('user001')
  await create.getByRole('list', { name: 'Собеседник' }).getByRole('button').first().click()
  await create.getByRole('button', { name: 'Создать' }).click()
  await expect(create).toBeHidden()
  const header = page.locator('header').filter({
    has: page.getByRole('button', { name: 'Поиск сообщений' }),
  })
  const title = ((await header.getByRole('heading').textContent()) ?? '').trim()
  expect(title).not.toBe('')

  const first = `Сбор штаба ${run} в 9:00`
  await send(page, first)
  const mine = page.getByRole('article').filter({ hasText: first })
  await expect(mine.getByRole('img', { name: 'Доставлено' })).toBeVisible()

  // Собеседник открывает беседу — у автора ✓✓ «Прочитано» без перезагрузки
  const peerContext = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  await resetWorkspaceState(peerContext.request)
  const peer = await peerContext.newPage()
  await peer.goto('/chats')
  await peer
    .getByRole('list', { name: 'Чаты' })
    .getByRole('listitem')
    .filter({ hasText: 'Системный Администратор' })
    .first()
    .getByRole('button')
    .first()
    .click()
  await expect(peer.getByRole('article').filter({ hasText: first })).toBeVisible()
  await expect(mine.getByRole('img', { name: 'Прочитано' })).toBeVisible({ timeout: 15_000 })

  // «Печатает»: сосед набирает — у автора строка под лентой
  await peer.getByLabel('Сообщение…').pressSequentially('Принято, выезжаю', { delay: 40 })
  await expect(page.getByText(/печатает…/)).toBeVisible()
  await peer.getByLabel('Сообщение…').fill('')

  // Правка своего: пометка «изменено», собеседник видит новый текст
  const edited = `Сбор штаба ${run} в 10:00`
  await messageMenu(page, first, 'Изменить')
  await page.getByLabel('Текст сообщения').fill(edited)
  await page.getByRole('button', { name: 'Сохранить' }).click()
  const editedMessage = page.getByRole('article').filter({ hasText: edited })
  await expect(editedMessage.getByText('изменено')).toBeVisible()
  await expect(peer.getByRole('article').filter({ hasText: edited })).toBeVisible()

  // Удаление: вместо сообщения строка «Сообщение удалено» у обоих
  await messageMenu(page, edited, 'Удалить')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
  await expect(page.getByRole('article').filter({ hasText: edited })).toHaveCount(0)
  await expect(page.getByText('Сообщение удалено').last()).toBeVisible()
  await expect(peer.getByRole('article').filter({ hasText: edited })).toHaveCount(0)

  // Выбор двух сообщений и пересылка одной командой
  const second = `Сводка ${run}: вода +20 см`
  const third = `Сводка ${run}: эвакуация к 18:00`
  await send(page, second)
  await send(page, third)
  await header.getByRole('button', { name: 'Действия с сообщением' }).click()
  await page.getByRole('menuitem', { name: 'Выбрать сообщения' }).click()
  for (const text of [second, third]) {
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('article').filter({ hasText: text }) })
      .last()
      .getByRole('checkbox')
      .click()
  }
  await expect(page.getByText('Выбрано 2 сообщения')).toBeVisible()
  await page.getByRole('button', { name: 'Переслать' }).click()
  const forward = page.getByRole('dialog')
  await forward.getByRole('combobox', { name: 'Куда переслать' }).click()
  await page.getByRole('option', { name: title }).first().click()
  await forward.getByRole('button', { name: 'Переслать' }).click()
  await expect(page.getByText('Переслано')).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: second })).toHaveCount(2)
  await expect(page.getByRole('article').filter({ hasText: third })).toHaveCount(2)

  // Архив у каждого свой: у автора беседа ушла из «Все», у собеседника осталась
  const sections = page.getByRole('tablist', { name: 'Чаты' })
  const list = page.getByRole('list', { name: 'Чаты' })
  await header.getByRole('button', { name: 'Действия с сообщением' }).click()
  await page.getByRole('menuitem', { name: 'Убрать в архив' }).click()
  await expect(page.getByText('Беседа в архиве')).toBeVisible()
  await expect(list.getByRole('listitem').filter({ hasText: title })).toHaveCount(0)
  await sections.getByRole('tab', { name: 'Архив' }).click()
  await expect(list.getByRole('listitem').filter({ hasText: title })).toBeVisible()
  await expect(
    peer.getByRole('list', { name: 'Чаты' }).getByRole('listitem').filter({
      hasText: 'Системный Администратор',
    }),
  ).not.toHaveCount(0)

  // Новое сообщение возвращает беседу со звуком из архива
  await send(peer, `Вернись ${run}`)
  await sections.getByRole('tab', { name: 'Все' }).click()
  await expect(list.getByRole('listitem').filter({ hasText: title })).toBeVisible({
    timeout: 15_000,
  })
  await peerContext.close()
})

/**
 * Обсуждение объекта в контекстной панели (ADR-0161): ответ в треде
 * открывается на месте, под корнем — счётчик ответов; своё — правится.
 */
test('обсуждение объекта: тред и правка своего в контекстной панели', async ({ page, request }) => {
  const run = Date.now().toString(36)
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const space = await request.post('/api/v1/spaces', {
    headers,
    data: { key: `thread-${run}`, name: `Треды ${run}` },
  })
  expect(space.ok(), await space.text()).toBeTruthy()
  const folder = await request.post('/api/v1/folders', {
    headers,
    data: { name: `Паводок ${run}`, spaceId: (await space.json()).id },
  })
  expect(folder.ok(), await folder.text()).toBeTruthy()

  await openWorkspace(page, request)
  await page.goto(`/o/${(await folder.json()).id}`)
  await page.getByRole('button', { name: 'Обсуждение', exact: true }).click()

  const root = `Кто дежурит ночью ${run}?`
  await page.getByLabel('Оставьте комментарий…').fill(root)
  await page.getByRole('button', { name: 'Отправить' }).click()
  await expect(page.getByRole('article').filter({ hasText: root })).toBeVisible()

  await messageMenu(page, root, 'Ответить в треде')
  const reply = `Дежурит смена Б ${run}`
  await page.getByLabel('Ответ в треде…').fill(reply)
  await page.getByRole('button', { name: 'Отправить' }).click()
  const thread = page.getByRole('list', { name: 'Тред' })
  await expect(thread.getByRole('article').filter({ hasText: root })).toBeVisible()
  await expect(thread.getByRole('article').filter({ hasText: reply })).toBeVisible()

  await page.getByRole('button', { name: 'К обсуждению' }).click()
  await expect(page.getByRole('button', { name: '1 ответ' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: reply })).toHaveCount(0)

  await messageMenu(page, root, 'Изменить')
  await page.getByLabel('Текст сообщения').fill(`Кто дежурит в субботу ${run}?`)
  await page.getByRole('button', { name: 'Сохранить' }).click()
  const changed = page.getByRole('article').filter({ hasText: `Кто дежурит в субботу ${run}?` })
  await expect(changed.getByText('изменено')).toBeVisible()
})
