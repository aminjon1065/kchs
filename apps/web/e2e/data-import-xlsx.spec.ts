import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, openWorkspace, test } from './fixtures.js'

const FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'files',
  'svodka-mart-2026.xlsx',
)

/**
 * Сценарий приёмки фазы 1 №1 (04-verification.md) на книге Excel: три листа
 * (справка, данные, итоги), в данных — даты и текстом «дд.мм.гггг», и ячейками
 * Excel, числа с пробелом тысяч и десятичной запятой, пустые значения. Мастер
 * распознаёт типы на выбранном листе, импорт завершается, у датасета есть версия
 * и профиль столбца. Импорт 1 млн строк проверяют замер движка и демо-датасеты
 * (5 млн строк, `pnpm db:seed --data=demo`, ADR-0063).
 */
test.describe('Данные: импорт книги Excel', () => {
  test('три листа, «грязные» даты и числа → датасет с версией и профилем', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)

    await page.getByRole('button', { name: 'Данные' }).first().click()
    await page.getByRole('button', { name: 'Загрузить файл' }).click()
    const wizard = page.getByRole('dialog', { name: 'Импорт данных' })
    await wizard.locator('input[type="file"]').setInputFiles(FILE)

    // Структура: книга, лист «Данные» из трёх
    await expect(wizard.getByText('XLSX', { exact: true })).toBeVisible({ timeout: 30_000 })
    await wizard.getByRole('combobox', { name: 'Лист' }).click()
    await expect(page.getByRole('option')).toHaveCount(3)
    await page.getByRole('option', { name: /^Данные/ }).click()
    await expect(wizard.getByRole('cell', { name: '1 234,50' })).toBeVisible({ timeout: 30_000 })
    await wizard.getByRole('button', { name: 'Далее' }).click()

    // Сопоставление: даты и числа распознаны, «Код» — ключ
    await expect(wizard.getByRole('combobox', { name: 'Тип: Дата' })).toHaveText(/Дата/)
    await expect(wizard.getByRole('combobox', { name: 'Тип: Ущерб, сомони' })).toHaveText(
      /Число|Десятичное|Деньги/,
    )
    await wizard.getByRole('checkbox', { name: 'Ключ: Код' }).check()
    const name = (
      await wizard.getByRole('textbox', { name: 'Название датасета' }).inputValue()
    ).trim()
    await wizard.getByRole('button', { name: 'Далее' }).click()

    await wizard.getByRole('button', { name: 'Запустить импорт' }).click()
    await expect(wizard.getByText('Импорт завершён')).toBeVisible({ timeout: 60_000 })
    await expect(wizard.getByText(/Добавлено 6/)).toBeVisible()
    await wizard.getByRole('button', { name: 'Открыть датасет' }).click()

    // Таблица: даты и числа приведены, пустое — пусто
    const grid = page.getByRole('grid', { name })
    await expect(grid.getByRole('gridcell', { name: /^1\s234,50?$/ })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: /^2\s000(,00)?$/ })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: '02.03.2026' })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: '04.03.2026' })).toBeVisible()

    // Версия импорта и профиль столбца
    await page.getByRole('tab', { name: 'Версии', exact: true }).click()
    const latest = page.getByRole('listitem').filter({ hasText: 'Версия 2' })
    await expect(latest.getByText('Импорт', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: /^Схема/ }).click()
    await page.getByRole('button', { name: 'Ущерб, сомони', exact: true }).click()
    await expect(page.getByText('Пустые')).toBeVisible()
    // Одна пустая из шести: 16,7 % (пробелы — неразрывные, как у форматирования процента)
    await expect(page.getByRole('definition').filter({ hasText: /^1\s·\s16,7\s%$/ })).toBeVisible()
  })
})
