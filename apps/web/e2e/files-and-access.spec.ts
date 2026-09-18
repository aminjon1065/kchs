import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

function sampleFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

const unique = () => Date.now().toString(36)

test.describe('Файлы, доступ и обсуждение', () => {
  test('сценарий: папка → загрузка → обсуждение → доступ', async ({ page, request }) => {
    await openWorkspace(page, request)

    // Файловый менеджер
    await openScreen(page, 'Файлы')
    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()

    // Новая папка
    const folderName = `Приёмка ${unique()}`
    await page.getByRole('button', { name: 'Новая папка' }).click()
    await page.getByLabel('Имя папки').fill(folderName)
    await page.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByRole('cell', { name: folderName })).toBeVisible()

    // Входим в папку и загружаем файл
    await page.getByRole('cell', { name: folderName }).click()
    await expect(page.getByText(folderName)).toBeVisible()

    const filePath = sampleFile(
      'svodka-po-pavodku.txt',
      'Сводка по паводковой обстановке\nУровень воды: 412 см\nКритический уровень: 400 см\n',
    )
    await page.locator('input[type="file"]').first().setInputFiles(filePath)
    await expect(page.getByRole('cell', { name: 'svodka-po-pavodku.txt' })).toBeVisible({
      timeout: 20_000,
    })

    // Открываем файл во вкладке
    await page.getByRole('cell', { name: 'svodka-po-pavodku.txt' }).dblclick()
    await expect(page.getByRole('button', { name: 'Скачать' })).toBeVisible()
    await expect(page.getByText('text/plain')).toBeVisible()

    // Движок извлёк текст — коллега видит содержимое без скачивания (сценарий 3)
    await expect(page.getByText('Уровень воды: 412 см')).toBeVisible({ timeout: 30_000 })

    // Обсуждение в контекст-панели
    await page.getByRole('button', { name: 'Обсуждение' }).click()
    const comment = `Уровень выше критического — нужна проверка ${unique()}`
    await page.getByPlaceholder('Оставьте комментарий…').fill(comment)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.getByText(comment)).toBeVisible({ timeout: 15_000 })

    // Активность объекта наполнилась
    await page.getByRole('button', { name: 'Активность' }).click()
    await expect(page.getByText(/написал в обсуждении/)).toBeVisible({ timeout: 15_000 })
  })

  test('диалог «Поделиться» объясняет источник доступа', async ({ page, request }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Файлы')

    const firstRow = page.locator('tbody tr').first()
    await expect(firstRow).toBeVisible()
    await firstRow.hover()
    await firstRow.getByRole('button', { name: 'Поделиться' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('КТО ИМЕЕТ ДОСТУП')).toBeVisible()
    await expect(dialog.getByText('Наследовать доступ от родителя')).toBeVisible()
    await expect(dialog.getByText(/Доступ выдан явно|Участник пространства/).first()).toBeVisible()

    await dialog.getByRole('button', { name: 'Почему есть доступ' }).first().click()
    await expect(page.getByText('Почему есть доступ')).toBeVisible()
  })
})
