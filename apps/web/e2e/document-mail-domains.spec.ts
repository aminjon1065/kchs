import type { Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Почтовые домены ведомств (N66, ADR-0136): белый список в карточке корреспондента-организации —
 * домен приводится к виду `mvd.tj`, один домен — у одного корреспондента, общие почтовые
 * сервисы не принимаются. Подстановку по домену при приёме письма проверяют интеграционные
 * тесты: настоящего ящика IMAP на стенде нет.
 */

async function openCorrespondents(page: Page) {
  await page.getByRole('button', { name: 'Документы', exact: true }).click()
  await page
    .getByRole('navigation', { name: 'Разделы документов' })
    .getByRole('button', { name: 'Корреспонденты', exact: true })
    .click()
  return page.getByRole('region', { name: 'Корреспонденты' })
}

test.describe('Документы: почтовые домены ведомств', () => {
  test('домен в карточке организации: запись, повтор у другого — ошибка, общий сервис — нет', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const domain = `mvd-${run}.example.tj`
    await openWorkspace(page, request)
    const directory = await openCorrespondents(page)

    await directory.getByRole('button', { name: 'Новый корреспондент', exact: true }).click()
    await directory.getByRole('textbox', { name: /^Название/ }).fill(`МВД ${run}`)
    await directory.getByRole('textbox', { name: 'Почтовые домены' }).fill(`@MVD-${run}.example.tj`)
    await directory.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(page.getByText('Корреспондент добавлен')).toBeVisible()
    // Сохранённый домен — в нижнем регистре и без «@»
    await expect(directory.getByRole('textbox', { name: 'Почтовые домены' })).toHaveValue(domain)

    await directory.getByRole('button', { name: 'Новый корреспондент', exact: true }).click()
    await directory.getByRole('textbox', { name: /^Название/ }).fill(`Двойник ${run}`)
    await directory.getByRole('textbox', { name: 'Почтовые домены' }).fill(domain)
    await directory.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(
      page.getByText(`Домен ${domain} уже указан у корреспондента «МВД ${run}»`),
    ).toBeVisible()

    // Лицу домены не положены — поля нет
    await directory.getByRole('radio', { name: 'Физическое лицо' }).click()
    await expect(directory.getByRole('textbox', { name: 'Почтовые домены' })).toHaveCount(0)

    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const publicDomain = await request.post('/api/v1/correspondents', {
      headers,
      data: { name: `Почта ${run}`, mailDomains: ['gmail.com'] },
    })
    expect(publicDomain.status()).toBe(400)
  })
})
