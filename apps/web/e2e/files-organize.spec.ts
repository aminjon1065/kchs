import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Раскладка файлов (ADR-0151) и массовые действия в списке документов (ADR-0152):
 * переименование папки, «Переместить в…», реестр выбранных документов в Excel и
 * диалоги массовых действий с числом выбранных.
 */
function sampleFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

const run = Date.now().toString(36)

test.describe('Раскладка файлов и массовые действия', () => {
  test('переименование папки и перенос файла диалогом «Переместить в…»', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Файлы')

    const draft = `Черновая ${run}`
    const target = `Разобрано ${run}`
    for (const name of [draft, `Входящие ${run}`]) {
      await page.getByRole('button', { name: 'Новая папка' }).click()
      await page.getByLabel('Имя папки').fill(name)
      await page.getByRole('button', { name: 'Создать' }).click()
      await expect(page.getByRole('gridcell', { name })).toBeVisible()
    }

    const row = (name: string) =>
      page.getByRole('row').filter({ has: page.getByRole('gridcell', { name }) })

    // Переименование папки — значок в строке
    await row(draft).getByRole('button', { name: 'Переименовать' }).click()
    const rename = page.getByRole('dialog', { name: 'Переименовать папку' })
    await rename.getByRole('textbox').fill(target)
    await rename.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByRole('gridcell', { name: target })).toBeVisible()
    await expect(page.getByRole('gridcell', { name: draft })).toBeHidden()

    // Файл в корне пространства
    const fileName = `akt-osmotra-${run}.txt`
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles(sampleFile(fileName, 'Акт осмотра дамбы\n'))
    await expect(page.getByRole('gridcell', { name: fileName })).toBeVisible({ timeout: 20_000 })

    // «Переместить в…»: дерево папок пространства, выбор цели, перенос
    await row(fileName).getByRole('button', { name: 'Переместить' }).click()
    const move = page.getByRole('dialog', { name: 'Переместить 1 объект' })
    // Корень дерева — само пространство, под ним папки
    await move.getByRole('treeitem', { name: target }).click()
    await move.getByRole('button', { name: 'Переместить сюда' }).click()
    await expect(move).toBeHidden()
    await expect(page.getByRole('gridcell', { name: fileName })).toBeHidden()

    // Файл теперь в папке
    await page.getByRole('gridcell', { name: target }).click()
    await expect(page.getByRole('gridcell', { name: fileName })).toBeVisible()
  })

  test('массовые действия в списке документов: реестр и диалоги', async ({ page, request }) => {
    await openWorkspace(page, request)
    await page.getByRole('button', { name: 'Документы', exact: true }).click()

    const rows = page.getByRole('checkbox', { name: 'Выделить строку' })
    await rows.nth(0).check()
    await rows.nth(1).check()
    await expect(page.getByText('Выбрано 2')).toBeVisible()

    // Реестр выбранных — книга Excel с сервера
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Реестр в Excel' }).click()
    expect((await download).suggestedFilename()).toBe('kchs-documents.xlsx')

    // На ознакомление: без адресатов отправить нельзя
    await page.getByRole('button', { name: 'На ознакомление' }).click()
    const acknowledge = page.getByRole('dialog', {
      name: 'Отправить 2 документа на ознакомление',
    })
    await expect(acknowledge.getByRole('button', { name: 'Отправить' })).toBeDisabled()
    await acknowledge.getByRole('button', { name: 'Отмена' }).click()

    // Подшить в дело: список открытых дел или объяснение, почему их нет
    await page.getByRole('button', { name: 'Подшить в дело' }).click()
    const file = page.getByRole('dialog', { name: 'Подшить 2 документа в дело' })
    await expect(
      file.getByRole('radiogroup', { name: 'Дело' }).or(file.getByText('Нет открытых дел')),
    ).toBeVisible()
    await file.getByRole('button', { name: 'Отмена' }).click()
    await expect(page.getByText('Выбрано 2')).toBeVisible()
  })
})
