import type { Page } from '@playwright/test'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/** Место вставки «+» на схеме: после шага или в ветвь группы. */
const insertAt = (page: Page, place: string) =>
  page.locator(`[data-insert="${place}"]`).getByRole('button', { name: 'Добавить шаг' })

/** Карточка шага на схеме — кнопка выбора. */
const card = (page: Page, key: string) =>
  page.locator(`[data-step-key="${key}"]`).locator('button[aria-pressed]').first()

/**
 * Конструктор маршрутов (P3-E01 S03, ADR-0087): администратор маршрутов
 * создаёт маршрут в консоли, собирает его на схеме — согласующие словами,
 * параллельная группа с ветвями, подпись, — видит ошибку проверки на месте,
 * смотрит JSON и назначения на примере документа, сохраняет черновик,
 * публикует и находит версию в истории.
 */
test.describe('Конструктор маршрутов', () => {
  test('маршрут из консоли: схема, проверка, предпросмотр, черновик и публикация', async ({
    page,
    request,
  }) => {
    const tag = Date.now().toString(36)
    const name = `Согласование письма ${tag}`
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Маршруты процессов' }).click()
    await page.getByRole('button', { name: 'Создать маршрут' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Название').fill(name)
    // Ключ подсказан транслитерацией названия
    await expect(dialog.getByLabel('Ключ')).toHaveValue(`soglasovanie_pisma_${tag}`)
    await dialog.getByRole('combobox', { name: 'Начать с' }).click()
    await page.getByRole('option', { name: 'Согласование и завершение' }).click()
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect(page.getByText('Маршрут создан')).toBeVisible()

    // Конструктор — во вкладке с названием маршрута
    await expect(page.getByRole('tab', { name })).toBeVisible()
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await expect(page.getByText('Черновик · версия 1')).toBeVisible()

    // Шаг согласования: название, согласующий словами, срок
    await card(page, 'approval_1').click()
    await page.getByLabel('Название', { exact: true }).fill('Согласование юриста')
    await page.getByRole('button', { name: 'Добавить', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Руководитель автора' }).click()
    const approvers = page.getByRole('list', { name: 'Согласующие' })
    await expect(approvers).toContainText('Руководитель подразделения автора')
    await expect(approvers).toContainText('Руководитель автора')
    await page.getByLabel('Срок, рабочих дней').fill('2')
    await expect(card(page, 'approval_1')).toContainText('Согласование юриста')
    await expect(card(page, 'approval_1')).toContainText('2 рабочих дня')
    await expect(page.getByText('Не сохранено · станет версией 1')).toBeVisible()

    // Параллельная группа после согласования — две ветви с согласованием
    await insertAt(page, 'after:approval_1').click()
    await page.getByRole('menuitem', { name: 'Параллельно' }).click()
    await expect(page.getByRole('region', { name: 'Ветвь 1' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Ветвь 2' })).toBeVisible()
    await expect(page.locator('[data-step-key="approval_2"]')).toBeVisible()
    await expect(page.locator('[data-step-key="approval_3"]')).toBeVisible()

    // Подпись после группы
    await insertAt(page, 'after:parallel_1').click()
    await page.getByRole('menuitem', { name: 'Подпись' }).click()
    await expect(card(page, 'sign_1')).toBeVisible()

    // Без завершения маршрут неверен: ошибка — на месте, публикация закрыта
    await page
      .locator('[data-step-key="end"]')
      .getByRole('button', { name: 'Действия с шагом «Завершение»' })
      .click()
    await page.getByRole('menuitem', { name: 'Удалить шаг' }).click()
    await page.getByRole('tab', { name: /Проверка/ }).click()
    await expect(page.getByText('Нужен шаг завершения (type: end)')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Опубликовать' })).toBeDisabled()

    // Вернуть завершение после подписи — ошибок нет
    await insertAt(page, 'after:sign_1').click()
    await page.getByRole('menuitem', { name: 'Завершение' }).click()
    await page.getByRole('tab', { name: /Проверка/ }).click()
    await expect(page.getByText('Ошибок нет — маршрут можно публиковать')).toBeVisible()

    // JSON отражает схему
    await page.getByRole('tab', { name: 'JSON' }).click()
    const json = page.getByLabel('Определение маршрута (JSON)')
    await expect(json).toHaveValue(/"type": "parallel"/)
    await expect(json).toHaveValue(/"manager\(author\)"/)
    await page.getByRole('tab', { name: 'Схема' }).click()

    // Предпросмотр на примере документа: назначения по шагам
    await page.getByRole('tab', { name: 'Предпросмотр' }).click()
    const objects = page.getByRole('list', { name: 'Пример объекта' })
    await expect(objects.getByRole('button').first()).toBeVisible({ timeout: 15_000 })
    await objects.getByRole('button').first().click()
    await page.getByRole('button', { name: 'Показать назначения' }).click()
    const steps = page.getByRole('list', { name: 'Назначения по шагам' })
    await expect(steps).toBeVisible()
    await expect(steps).toContainText('Согласование юриста')
    await expect(steps).toContainText('sign_1')

    // Черновик и публикация
    await page.getByRole('button', { name: 'Сохранить черновик' }).click()
    await expect(page.getByText('Черновик сохранён — версия 1')).toBeVisible()
    await page.getByRole('button', { name: 'Опубликовать' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Опубликовать' }).click()
    await expect(page.getByText('Опубликована версия 1')).toBeVisible()
    await expect(page.getByText('Опубликована · версия 1')).toBeVisible()

    // История версий
    await page.getByRole('button', { name: 'Ещё' }).click()
    await page.getByRole('menuitem', { name: 'История версий' }).click()
    const history = page.getByRole('dialog', { name: 'История версий' })
    await expect(history.getByText('Версия 1')).toBeVisible()
    await expect(history.getByText(/опубликована/)).toBeVisible()
  })
})
