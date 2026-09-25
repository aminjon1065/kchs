import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Библиотека отчётов (ADR-0164): отчёт из встроенного шаблона, A3 и оглавление, блок
 * «Дашборд», сохранение версии и отметка «Шаблон библиотеки», оглавление на странице печати.
 */
test.describe('Отчёты: шаблоны, версии, оглавление', () => {
  test('отчёт из шаблона, печать A3 с оглавлением, дашборд, версия и шаблон библиотеки', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const name = `Сводка ${Date.now().toString(36)}`

    await openWorkspace(page, request)
    // Каталог «Данные» — с рейки: в палитре его обгоняют страницы с похожим названием
    await page.getByRole('button', { name: 'Данные' }).first().click()
    await page.getByRole('button', { name: 'Отчёт', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'Новый отчёт' })
    await create.getByRole('button', { name: /Ежедневная оперативная сводка/ }).click()
    await create.getByLabel('Название').fill(name)
    await create.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Отчёт создан')).toBeVisible()

    // Блоки шаблона на месте
    await expect(page.getByText('Показатели за сутки')).toBeVisible()
    await expect(page.getByText('Происшествия на карте')).toBeVisible()

    // Печать: A3, оглавление
    await page.getByRole('radio', { name: 'A3' }).click()
    await page.getByRole('switch', { name: 'Оглавление' }).click()
    await expect(page.getByRole('switch', { name: 'Оглавление' })).toBeChecked()

    // Блок «Дашборд» в конец: первый дашборд из списка
    await page.getByRole('button', { name: 'Добавить блок' }).click()
    await page.getByRole('menuitem', { name: 'Дашборд' }).click()
    await page.getByRole('combobox', { name: 'Дашборд' }).last().click()
    await page.getByRole('option').nth(1).click()

    // Версия с подписью и отметка «Шаблон библиотеки»
    await page.getByRole('button', { name: 'Версии и шаблон' }).click()
    const library = page.getByRole('dialog', { name: 'Версии и шаблон' })
    await library.getByLabel('Подпись версии').fill('Перед совещанием')
    await library.getByRole('button', { name: 'Сохранить версию' }).click()
    await expect(page.getByText('Версия 1 сохранена')).toBeVisible()
    await expect(library.getByText('Перед совещанием')).toBeVisible()
    await library.getByRole('switch', { name: 'Шаблон библиотеки' }).click()
    await expect(page.getByText('Отчёт стал шаблоном библиотеки')).toBeVisible()
    await page.keyboard.press('Escape')

    // Отчёт — в выборе шаблона нового отчёта
    await page.getByRole('button', { name: 'Данные' }).first().click()
    await page.getByRole('button', { name: 'Отчёт', exact: true }).click()
    const again = page.getByRole('dialog', { name: 'Новый отчёт' })
    await expect(again.getByRole('button', { name: new RegExp(name) })).toBeVisible()
    await again.getByRole('button', { name: 'Отмена' }).click()

    // Страница печати: «Содержание» с разделами шаблона
    const found = await request.get(
      `/api/v1/objects?types=report&q=${encodeURIComponent(name)}&limit=5`,
    )
    const reportId = ((await found.json()).items as Array<{ id: string; title: string }>).find(
      (item) => item.title === name,
    )?.id
    expect(reportId).toBeTruthy()
    const preview = await page.context().newPage()
    await preview.goto(`/print/report-preview/${reportId}`)
    const toc = preview.getByRole('navigation', { name: 'Содержание' })
    await expect(toc).toBeVisible({ timeout: 60_000 })
    await expect(toc.getByText('Оперативная обстановка за сутки')).toBeVisible()
    await expect(toc.getByText('Показатели за сутки')).toBeVisible()
    await preview.close()
  })
})
