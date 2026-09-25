import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Номер «подразделение-дело/номер» (N12, ADR-0134) и импорт номенклатуры из Excel (N20,
 * ADR-0135). Журнал, тип и дело сценарий заводит сам: на общем стенде копятся дела прошлых
 * прогонов, и подбор дела по типу должен быть однозначным. Импорт проверяется образцом в
 * режиме «Проверить» — стенд не меняется.
 */

const context = (page: Page) => page.getByRole('complementary', { name: 'Контекст' })

test.describe('Документы: номер по делу номенклатуры и импорт номенклатуры', () => {
  test('дело подобрано по типу, номер виден до регистрации и попадает в карточку', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const year = Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' })
        .format(new Date())
        .slice(0, 4),
    )
    const index = `77-01-${run}`

    const journal = await request.post('/api/v1/journals', {
      headers,
      data: { name: `Справки ${run}`, prefix: `СП${run.slice(-3)}` },
    })
    expect(journal.ok(), await journal.text()).toBeTruthy()
    const type = await request.post('/api/v1/document-types', {
      headers,
      data: {
        key: `e2e_note_${run}`,
        name: { ru: `Справка ${run}` },
        direction: 'internal',
        numbering: { journalId: (await journal.json()).id, format: null },
      },
    })
    expect(type.ok(), await type.text()).toBeTruthy()
    const typeId = (await type.json()).id as string
    const created = await request.post('/api/v1/cases', {
      headers,
      data: { index, title: `Справки отдела ${run}`, year, documentTypeIds: [typeId] },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const draft = await request.post('/api/v1/documents', {
      headers,
      data: { typeId, subject: `Справка о готовности ПВР ${run}` },
    })
    expect(draft.ok(), await draft.text()).toBeTruthy()

    await openWorkspace(page, request)
    await page.goto(`/o/${(await draft.json()).id}`)
    await context(page).getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Регистрация документа' })
    await expect(dialog.getByRole('combobox', { name: 'Дело по номенклатуре' })).toContainText(
      index,
    )
    await expect(dialog.getByText(`Номер будет: ${index}/1`)).toBeVisible()
    await dialog.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
    await expect(page.getByText(`Зарегистрирован № ${index}/1`)).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Дело по номенклатуре', exact: true }),
    ).toBeVisible()
  })

  test('импорт номенклатуры: образец скачивается и проверяется без изменений', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()
    await page
      .getByRole('navigation', { name: 'Разделы документов' })
      .getByRole('button', { name: 'Номенклатура дел', exact: true })
      .click()
    const cases = page.getByRole('region', { name: 'Номенклатура дел' })
    await cases.getByRole('button', { name: 'Ещё', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Импорт из Excel' }).click()
    const dialog = page.getByRole('dialog', { name: 'Импорт номенклатуры из Excel' })

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('link', { name: 'Скачать образец' }).click(),
    ])
    const sample = await download.path()
    await dialog.getByLabel('Выбрать файл').setInputFiles({
      name: 'номенклатура.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await readFile(sample as string),
    })
    await expect(dialog.getByText('номенклатура.xlsx')).toBeVisible()

    await dialog.getByRole('button', { name: 'Проверить', exact: true }).click()
    await expect(dialog.getByText('Лист «Номенклатура»')).toBeVisible()
    const rows = dialog.getByRole('grid', { name: 'Строки файла' })
    await expect(rows).toBeVisible()
    await expect(rows.getByText('03-12', { exact: true })).toBeVisible()
  })
})
