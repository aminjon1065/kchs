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
    await expect(page.getByRole('gridcell', { name: folderName })).toBeVisible()

    // Входим в папку и загружаем файл
    await page.getByRole('gridcell', { name: folderName }).click()
    await expect(page.getByText(folderName)).toBeVisible()

    const filePath = sampleFile(
      'svodka-po-pavodku.txt',
      'Сводка по паводковой обстановке\nУровень воды: 412 см\nКритический уровень: 400 см\n',
    )
    await page.locator('input[type="file"]').first().setInputFiles(filePath)
    await expect(page.getByRole('gridcell', { name: 'svodka-po-pavodku.txt' })).toBeVisible({
      timeout: 20_000,
    })

    // Открываем файл во вкладке
    await page.getByRole('gridcell', { name: 'svodka-po-pavodku.txt' }).dblclick()
    await expect(page.getByRole('button', { name: 'Скачать' })).toBeVisible()
    await expect(page.getByText('text/plain')).toBeVisible()

    // Движок извлёк текст — коллега видит содержимое без скачивания (сценарий 3)
    await expect(page.getByText('Уровень воды: 412 см')).toBeVisible({ timeout: 30_000 })

    // Обсуждение в контекст-панели: сбой отправки не теряет набранный текст
    await page.getByRole('button', { name: 'Обсуждение' }).click()
    const comment = `Уровень выше критического — нужна проверка ${unique()}`
    const field = page.getByPlaceholder('Оставьте комментарий…')
    await field.fill(comment)
    const messages = '**/discussion/messages'
    await page.route(messages, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'about:blank',
              title: 'Сервис временно недоступен',
              status: 503,
              code: 'service_unavailable',
            }),
          })
        : route.fallback(),
    )
    await page.getByRole('button', { name: 'Отправить' }).click()
    // Ошибка — под полем, кнопка «Отправить» остаётся доступной для повтора
    await expect(page.getByRole('alert').filter({ hasText: 'Не отправлено' })).toHaveText(
      'Не отправлено: Сервис временно недоступен',
    )
    await expect(field).toHaveValue(comment)
    await page.unroute(messages)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.getByText(comment)).toBeVisible({ timeout: 15_000 })
    await expect(field).toHaveValue('')
    await expect(page.getByRole('alert').filter({ hasText: 'Не отправлено' })).toHaveCount(0)

    // Активность объекта наполнилась
    await page.getByRole('button', { name: 'Активность' }).click()
    await expect(page.getByText(/написал в обсуждении/)).toBeVisible({ timeout: 15_000 })
  })

  test('диалог «Поделиться» объясняет источник доступа', async ({ page, request }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Файлы')

    // Первая строка данных таблицы (строка 1 — заголовок)
    const firstRow = page.getByRole('grid').getByRole('row').nth(1)
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
