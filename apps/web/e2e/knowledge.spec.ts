import { expect, test } from './fixtures.js'

/**
 * База знаний (P5-E01, ADR-0095): раздел «Знания» — дерево страниц
 * пространства; страница заводится по шаблону, правится блоками совместного
 * документа, публикуется версией, сравнивается с текущим текстом и
 * откатывается; срок пересмотра и ознакомление — в отдельной вкладке.
 */
test.describe('Знания: страница базы знаний', () => {
  test('шаблон → правка → публикация → версии и сравнение → пересмотр', async ({ page }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const title = `Порядок оповещения ${run}`

    // Раздел «Знания» на рейке: дерево пространства и поиск
    await page.goto('/knowledge')
    await expect(page.getByRole('textbox', { name: 'Поиск по базе знаний' })).toBeVisible()

    // Новая страница по шаблону «Инструкция»
    await page.getByRole('button', { name: 'Новая страница' }).click()
    await page.getByLabel('Название').fill(title)
    await page.getByRole('combobox', { name: 'Шаблон' }).click()
    await page.getByRole('option', { name: 'Инструкция' }).click()
    await page.getByRole('button', { name: 'Создать' }).click()

    // Страница открылась вкладкой: блоки шаблона и оглавление на месте
    await expect(page.getByRole('tab', { name: 'Версии' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Оглавление' })).toBeVisible()
    await expect(page.getByText('Черновик')).toBeVisible()

    // Свой блок текста: правка уходит в совместный документ
    await page.getByRole('button', { name: 'Текст', exact: true }).click()
    const blocks = page.getByRole('article', { name: 'Текст' })
    const fresh = blocks.last()
    await fresh.getByRole('textbox', { name: 'Подпись блока' }).fill('Кто оповещает')
    await fresh.getByRole('textbox', { name: 'Текст блока' }).fill('Дежурный по управлению')

    // Публикация: текущий текст становится версией 1
    await page.getByRole('button', { name: 'Опубликовать' }).first().click()
    await page.getByLabel('Примечание к версии').fill('Первая редакция')
    const review = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    await page.getByLabel('Следующий пересмотр').fill(review)
    await page.getByRole('button', { name: 'Опубликовать' }).last().click()
    await expect(page.getByText('Опубликована').first()).toBeVisible()

    // Версии: снимок публикации, сравнение с текущим текстом
    await page.getByRole('tab', { name: 'Версии' }).click()
    await expect(page.getByText('Версия 1')).toBeVisible()
    await page.getByRole('button', { name: 'Сравнить' }).click()
    await expect(page.getByRole('dialog', { name: 'Сравнение версий' })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Сравнение версий' })
      .getByRole('button', { name: 'Закрыть' })
      .last()
      .click()

    // Откат: текущий текст сохраняется версией, страница возвращается к снимку
    await page.getByRole('button', { name: 'Откатить к версии' }).first().click()
    await expect(page.getByText('Версия 2')).toBeVisible()

    // Пересмотр: владелец и срок видны, страницу можно вернуть на пересмотр
    await page.getByRole('tab', { name: 'Пересмотр' }).click()
    await expect(page.getByText(review, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Отправить на ознакомление' }).click()
    await expect(page.getByRole('dialog', { name: 'Кого ознакомить со страницей' })).toBeVisible()
    await page.getByRole('button', { name: 'Отмена' }).click()

    // Поиск по базе знаний находит страницу по словам из её текста
    await page.goto('/knowledge')
    await page.getByRole('textbox', { name: 'Поиск по базе знаний' }).fill('Дежурный')
    await expect(page.getByRole('button').filter({ hasText: title })).toBeVisible({
      timeout: 20_000,
    })
  })

  test('комментарий к фрагменту открывает обсуждение блока', async ({ page, request }) => {
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = await request.get('/api/v1/spaces')
    const spaceId = ((await spaces.json()).items as Array<{ id: string; key: string }>).find(
      (space) => space.key === 'org',
    )?.id
    expect(spaceId, 'пространство «Общее» найдено').toBeTruthy()

    const created = await request.post('/api/v1/pages', {
      headers,
      data: { title: `Памятка ${run}`, spaceId, template: 'faq' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const pageId = (await created.json()).id as string

    await page.goto(`/o/${pageId}`)
    // Блоки приходят совместным документом — ждём, пока он подключится
    await expect(page.getByRole('article').first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Обсудить фрагмент' }).first().click()
    await expect(page.getByText('Комментарии к фрагменту')).toBeVisible()
    await page.getByRole('textbox', { name: 'Комментарий' }).fill(`Уточнить срок ${run}`)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await expect(page.getByText(`Уточнить срок ${run}`)).toBeVisible()

    // Без якоря обсуждение показывает всё — комментарий к фрагменту в нём тоже
    await page.getByRole('button', { name: 'Ко всему объекту' }).click()
    await expect(page.getByText(`Уточнить срок ${run}`)).toBeVisible()
  })
})
