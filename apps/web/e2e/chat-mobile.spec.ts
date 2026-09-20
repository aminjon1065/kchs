import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Мобильный веб чатов (P4-E01 S05, 01-ux-concept.md — адаптив): в нижней
 * навигации есть «Чаты», файлы уехали в «Ещё», а сам экран показывает одну
 * панель — список бесед или беседу с кнопкой возврата.
 */
test('чаты на мобильном: нижняя навигация, одна панель, возврат к списку', async ({
  page,
  request,
}) => {
  await openWorkspace(page, request)

  const nav = page.getByRole('navigation', { name: 'Основная навигация' })
  await expect(nav).toBeVisible()
  await nav.getByRole('button', { name: 'Чаты' }).click()

  // Панель одна: список бесед занимает экран, ленты нет
  const list = page.getByRole('list', { name: 'Чаты' })
  await expect(list).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Поиск сообщений' })).toBeHidden()

  // Беседа открывается на весь экран, список уходит
  await list.getByRole('listitem').first().getByRole('button').first().click()
  await expect(page.getByRole('button', { name: 'Поиск сообщений' })).toBeVisible()
  await expect(list).toBeHidden()

  // «Назад» возвращает к списку
  await page.getByRole('button', { name: 'Назад' }).first().click()
  await expect(list).toBeVisible()
  await expect(page.getByRole('button', { name: 'Поиск сообщений' })).toBeHidden()

  // Файлы остались доступны — в меню «Ещё»
  await nav.getByRole('button', { name: 'Ещё' }).click()
  await expect(page.getByRole('menuitem', { name: 'Файлы' })).toBeVisible()
})
