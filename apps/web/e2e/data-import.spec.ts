import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Импорт файла в новый датасет (P1-E02, сценарий приёмки фазы 1 №1 в малом):
 * «грязный» CSV — точка с запятой, десятичная запятая, разделитель тысяч,
 * даты дд.мм.гггг — мастер распознаёт, движок нормализует, воркер загружает,
 * строки видны в таблице датасета.
 */
test.describe('Данные: импорт файла', () => {
  test('мастер: файл → структура → сопоставление → запуск → таблица', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const name = `proisshestviya-${run}`
    const csv = [
      'Код;Район;Ущерб, сомони;Дата',
      'П-1;Хатлон;1 234,50;01.03.2026',
      'П-2;Согд;75;02.03.2026',
      'П-3;ГБАО;;03.03.2026',
      'П-4;Хатлон;12,5;04.03.2026',
    ].join('\n')

    await page.getByRole('button', { name: 'Данные' }).first().click()
    await page.getByRole('button', { name: 'Загрузить файл' }).click()
    const wizard = page.getByRole('dialog', { name: 'Импорт данных' })
    await wizard.locator('input[type="file"]').setInputFiles({
      name: `${name}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    })

    // Структура: формат и предпросмотр
    await expect(wizard.getByText('CSV', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(wizard.getByRole('cell', { name: '1 234,50' })).toBeVisible()
    await wizard.getByRole('button', { name: 'Далее' }).click()

    // Сопоставление: типы определены, «Код» — ключ
    await expect(wizard.getByRole('textbox', { name: 'Название датасета' })).toHaveValue(name)
    await wizard.getByRole('checkbox', { name: 'Ключ: Код' }).check()
    await wizard.getByRole('button', { name: 'Далее' }).click()

    // Проверка и запуск
    await wizard.getByRole('button', { name: 'Запустить импорт' }).click()
    await expect(wizard.getByText('Импорт завершён')).toBeVisible({ timeout: 60_000 })
    await expect(wizard.getByText(/Добавлено 4/)).toBeVisible()
    await wizard.getByRole('button', { name: 'Открыть датасет' }).click()

    // Таблица датасета: 4 строки, числа и даты приведены
    const grid = page.getByRole('grid', { name })
    await expect(grid).toBeVisible()
    await expect(page.getByText('4 строки')).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: '1 234,5' })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: '01.03.2026' })).toBeVisible()
  })
})
