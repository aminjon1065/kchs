import { expect, type Page, test } from '@playwright/test'

/**
 * Взаимодействия DataGrid на историях Storybook: клавиатура, буфер обмена
 * (настоящие ⌘C/⌘V через системный буфер), правка, отмена, мышь, столбцы.
 * Снимки и axe — в stories.spec.ts; здесь — поведение.
 */

async function openStory(page: Page, id: string): Promise<void> {
  await page.goto(`/iframe.html?id=${id}&viewMode=story`)
  await page.waitForFunction(() => {
    const preview = (
      window as unknown as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }
    ).__STORYBOOK_PREVIEW__
    const current = preview?.currentRender?.phase
    return current && ['completed', 'finished', 'errored', 'aborted'].includes(current)
  })
}

function helpers(page: Page, name: string) {
  const grid = page.getByRole('grid', { name })
  const status = page.getByRole('status')
  return {
    grid,
    status,
    footer: status.locator('..'),
    cell: (row: number, col: number) => grid.locator(`[data-row="${row}"] [data-col="${col}"]`),
    /** Активная ячейка «строка:столбец» по aria-activedescendant. */
    active: async () => {
      const id = await grid.getAttribute('aria-activedescendant')
      if (!id) return null
      const cell = page.locator(`[id="${id}"]`)
      const row = await cell.evaluate((node) =>
        node.closest('[data-row]')?.getAttribute('data-row'),
      )
      return `${row}:${await cell.getAttribute('data-col')}`
    },
    focused: () => grid.evaluate((node) => node === document.activeElement),
  }
}

test('DataGrid: клавиатура, правка, буфер обмена, отмена', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openStory(page, 'composites-data-grid--basic')
  const { grid, status, cell, active, focused } = helpers(page, 'Районы')

  // Фокус — первая ячейка; стрелки двигают активную ячейку
  await grid.focus()
  expect(await active()).toBe('0:0')
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown']) {
    await page.keyboard.press(key)
  }
  expect(await active()).toBe('2:3')

  // ⌘C — значение с полной точностью и десятичной запятой
  const original = (await cell(2, 3).textContent()) ?? ''
  await page.keyboard.press('ControlOrMeta+C')
  await expect(status).toHaveText('Скопирована 1 ячейка')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.replace(',', '.')).toBe(
    String(Number(original.replace(/\s/g, '').replace(',', '.'))),
  )
  expect(await focused()).toBe(true)

  // Набор начинает правку, Enter сохраняет и спускается ниже
  await page.keyboard.type('2500,5')
  await page.keyboard.press('Enter')
  await expect(cell(2, 3)).toHaveText('2 500,5')
  expect(await active()).toBe('3:3')

  // Отмена и повтор
  await page.keyboard.press('ControlOrMeta+Z')
  await expect(status).toHaveText('Правка отменена')
  await expect(cell(2, 3)).toHaveText(original)
  await page.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(status).toHaveText('Правка повторена')
  await expect(cell(2, 3)).toHaveText('2 500,5')

  // Delete очищает
  await cell(2, 3).click()
  await page.keyboard.press('Delete')
  await expect(status).toHaveText('Очищена 1 ячейка')
  await expect(cell(2, 3)).toHaveText('')

  // ⌘V — блок из буфера с активной ячейки
  await page.evaluate(() => navigator.clipboard.writeText('10\t20\n30\t40'))
  await cell(0, 3).click()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(status).toHaveText('Вставлено 4 значения')
  await expect(cell(0, 3)).toHaveText('10,0')
  await expect(cell(1, 4)).toHaveText('40,00')
  expect(await focused()).toBe(true)

  // F2 и Esc — правка отменяется, фокус возвращается в таблицу
  await cell(1, 1).click()
  await page.keyboard.press('F2')
  await page.keyboard.type('xyz')
  await page.keyboard.press('Escape')
  await expect(cell(1, 1)).not.toHaveText(/xyz/)
  expect(await focused()).toBe(true)

  // Пробел переключает логическое
  await cell(0, 8).click()
  const before = (await cell(0, 8).textContent()) ?? ''
  await page.keyboard.press(' ')
  await expect(cell(0, 8)).not.toHaveText(before)

  // Столбец только для чтения объясняет, почему набор не правит
  await cell(0, 7).click()
  await page.keyboard.press('a')
  await expect(status).toHaveText('Столбец только для чтения')

  expect(errors).toEqual([])
})

test('DataGrid: выделение мышью, строки, столбцы', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openStory(page, 'composites-data-grid--basic')
  const { grid, status, footer, cell, active, focused } = helpers(page, 'Районы')

  // Протягивание — диапазон 3×3 и сводка
  const from = await cell(3, 2).boundingBox()
  const to = await cell(5, 4).boundingBox()
  if (!from || !to) throw new Error('ячейки не видны')
  await page.mouse.move(from.x + 10, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(to.x + 10, to.y + 10, { steps: 5 })
  await page.mouse.up()
  await expect(footer).toContainText('Выделено: 9')
  await expect(footer).toContainText('Сумма:')

  // Строки через номер строки: щелчок и Shift+щелчок, копирование строк целиком
  await grid.locator('[data-row="1"] [data-gutter]').click()
  await grid.locator('[data-row="3"] [data-gutter]').click({ modifiers: ['Shift'] })
  await expect(footer).toContainText('Выделены 3 строки')
  await page.keyboard.press('ControlOrMeta+C')
  await expect(status).toHaveText('Скопированы 33 ячейки')
  const tsv = await page.evaluate(() => navigator.clipboard.readText())
  expect(tsv.split('\n')).toHaveLength(3)
  expect(tsv.split('\n')[0]?.split('\t')).toHaveLength(11)

  // Сортировка щелчком по заголовку
  const area = page.getByRole('columnheader', { name: /Площадь/ })
  await area.getByRole('button').first().click()
  await expect(area).toHaveAttribute('aria-sort', 'ascending')

  // Ширина — перетаскиванием края заголовка
  const region = page.getByRole('columnheader', { name: /Регион/ })
  const box = await region.boundingBox()
  if (!box) throw new Error('заголовок не виден')
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 60, box.y + box.height / 2, { steps: 6 })
  await page.mouse.up()
  expect((await region.boundingBox())?.width ?? 0).toBeGreaterThan(box.width + 40)

  // Порядок — перетаскиванием заголовка: «Бюджет» перед «Население»
  const budget = await page.getByRole('columnheader', { name: /Бюджет/ }).boundingBox()
  const population = await page.getByRole('columnheader', { name: /Население/ }).boundingBox()
  if (!budget || !population) throw new Error('заголовки не видны')
  await page.mouse.move(budget.x + 30, budget.y + budget.height / 2)
  await page.mouse.down()
  await page.mouse.move(population.x + 10, population.y + population.height / 2, { steps: 8 })
  await page.mouse.up()
  const order = await page.getByRole('columnheader').allTextContents()
  expect(order.findIndex((text) => text.includes('Бюджет'))).toBeLessThan(
    order.findIndex((text) => text.includes('Население')),
  )

  // Tab с последнего столбца — на первый столбец следующей строки
  await cell(4, 0).click()
  await page.keyboard.press('ControlOrMeta+ArrowRight')
  await page.keyboard.press('Tab')
  expect(await active()).toBe('5:0')

  // Меню столбца с клавиатуры (Alt+↓), Esc возвращает фокус в таблицу
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Фильтр по столбцу' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  // Radix возвращает фокус после размонтирования меню, на следующем такте
  await expect.poll(focused).toBe(true)
})

test('DataGrid: 100 000 строк — переход в конец, загрузка окна, размер DOM', async ({ page }) => {
  await openStory(page, 'composites-data-grid--large')
  const { grid, cell } = helpers(page, 'Показатели')
  await grid.focus()
  await page.keyboard.press('ControlOrMeta+End')
  // Строка загружается окном через 120 мс: сначала скелет, затем значения
  await expect(cell(99_999, 99)).not.toHaveText('', { timeout: 3000 })
  await expect(page.getByRole('columnheader', { name: 'Показатель 99' })).toBeVisible()
  // Виртуализация строк и столбцов: в DOM — окно, а не 10 млн ячеек
  expect(await grid.getByRole('gridcell').count()).toBeLessThan(1000)
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(cell(0, 0)).toHaveText('R-000001')
})
