import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Правила автоматизации и расписания (P5-E02, ADR-0096): администратор создаёт
 * правило из шаблона, собирает «когда / если / то» в конструкторе, видит
 * проверку определения, проверяет тестовым прогоном «что бы произошло»,
 * включает правило и находит его расписание на экране «Расписания».
 */
test.describe('Правила автоматизации', () => {
  test('правило из шаблона: конструктор, проверка, тестовый прогон и включение', async ({
    page,
    request,
  }) => {
    const tag = Date.now().toString(36)
    const name = `Тег на новую папку ${tag}`

    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Правила автоматизации' }).click()
    await expect(page.getByRole('heading', { name: 'Правила автоматизации' })).toBeVisible()

    // Создание: название, пространство и шаблон из галереи
    await page.getByRole('button', { name: 'Создать правило' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Название').fill(name)
    await dialog.getByRole('combobox', { name: 'Пространство' }).click()
    await page.getByRole('option').first().click()
    await dialog.getByText('Крупный договор — уведомить финансистов').click()
    await dialog.getByRole('button', { name: 'Создать правило' }).click()
    await expect(page.getByText('Правило создано')).toBeVisible()

    // Конструктор открылся во вкладке с названием правила
    await expect(page.getByRole('tab', { name })).toBeVisible()
    await expect(page.getByRole('heading', { name })).toBeVisible()

    // Без служебного пользователя правило не сохранить: проверка показывает ошибку
    await expect(page.getByText('Укажите служебного пользователя')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

    // «Когда»: событие каталога и отбор по типу объекта
    await page.getByLabel('Тип события').fill('object.created')
    await page.getByRole('button', { name: 'Добавить поле' }).click()
    await page.getByLabel('Поле конверта').last().fill('object.type')
    await page.getByLabel('Значение').last().fill('folder')

    // «Если»: условие на языке выражений платформы
    await page.getByRole('button', { name: 'Добавить условие' }).click()
    await page
      .getByLabel('Если')
      .last()
      .fill(`contains(object.title, 'Автоправило ${tag}')`)

    // «То»: единственное действие — поставить тег
    await page.getByRole('combobox', { name: 'Действие' }).first().click()
    await page.getByRole('option', { name: 'Добавить тег' }).click()
    await page.getByLabel('Тег').fill(`авто-${tag}`)

    // Служебный пользователь: сотрудник с правами на пространство
    const runAs = await request.get('/api/v1/users?q=user001')
    const userId = (await runAs.json()).items[0].id as string
    await page.getByLabel('Работает от имени').fill(userId)
    await expect(page.getByText('Ошибок нет')).toBeVisible()

    // Тестовый прогон: правило ничего не делает, только показывает, что было бы
    await page.getByRole('tab', { name: 'Тестовый прогон' }).click()
    await page.getByRole('button', { name: 'Проверить' }).click()
    await expect(page.getByText(/Сработало на \d+ из \d+/)).toBeVisible()

    // Сохранение и включение
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Правило сохранено')).toBeVisible()
    await page.getByLabel('Включено').click()
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Правило сохранено')).toBeVisible()

    // Список правил: правило включено и видно с триггером
    await page.getByRole('tab', { name: 'Администрирование' }).click()
    await expect(page.getByRole('row', { name: new RegExp(name) })).toContainText('Событие')
  })

  test('экран «Расписания»: проверки платформы, выключение и запуск', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Расписания' }).click()
    await expect(page.getByRole('heading', { name: 'Расписания' })).toBeVisible()

    const row = page.getByRole('row', { name: /Корзина: окончательное удаление/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Проверка платформы')

    // Выключение снимает ближайший запуск, включение возвращает
    await row.getByRole('switch').click()
    await expect(page.getByText('Расписание обновлено')).toBeVisible()
    await expect(row).toContainText('—')
    await row.getByRole('switch').click()
    await expect(page.getByText('Расписание обновлено')).toBeVisible()

    // «Выполнить сейчас» ставит задание в очередь
    await row.getByRole('button', { name: 'Выполнить сейчас' }).click()
    await expect(page.getByText('Задание поставлено в очередь')).toBeVisible()
  })
})
