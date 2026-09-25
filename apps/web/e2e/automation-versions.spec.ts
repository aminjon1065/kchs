import { createServiceAccount, expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Правила автоматизации, «закончить разработку» (ADR-0163): группа условий «любое из»,
 * ветка «иначе», версии с возвратом, копия правила, файл правила и импорт.
 */
test.describe('Правила автоматизации: группы, «иначе», версии, копия и файл', () => {
  test('конструктор с группой и «иначе», возврат версии, копия, экспорт и импорт', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const tag = Date.now().toString(36)
    const name = `Ветки ${tag}`

    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Правила автоматизации' }).click()
    await page.getByRole('button', { name: 'Создать правило' }).click()
    const create = page.getByRole('dialog')
    await create.getByLabel('Название').fill(name)
    await create.getByRole('combobox', { name: 'Пространство' }).click()
    await page.getByRole('option').first().click()
    await create.getByText('Крупный договор — уведомить финансистов').click()
    await create.getByRole('button', { name: 'Создать правило' }).click()
    await expect(page.getByRole('heading', { name })).toBeVisible()

    // «Если»: вложенная группа «любое из» к условиям шаблона
    await page.getByRole('button', { name: 'Добавить группу' }).click()
    const ops = page.getByRole('combobox', { name: 'Как объединять условия' })
    await expect(ops).toHaveCount(2)
    await ops.nth(1).click()
    await page.getByRole('option', { name: 'Выполнено любое из условий' }).click()
    await page.getByLabel('Если').last().fill(`contains(object.title, 'Важное ${tag}')`)
    await expect(page.getByText('Условие целиком:')).toBeVisible()
    // Группа из одного условия — в скобках после «и» условий шаблона
    await expect(page.getByText(`and (contains(object.title, 'Важное ${tag}'))`)).toBeVisible()

    // «Иначе»: поставить тег, когда условие не выполнено
    await page.getByRole('button', { name: 'Добавить ветку «иначе»' }).click()
    await page.getByRole('combobox', { name: 'Действие' }).last().click()
    await page.getByRole('option', { name: 'Добавить тег' }).click()
    await page.getByLabel('Тег').last().fill(`обычное-${tag}`)

    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const robot = await createServiceAccount(
      request,
      `Робот веток ${tag}`,
      spaces.slice(0, 20).map((space) => ({ spaceId: space.id, role: 'editor' as const })),
    )
    await page.getByRole('combobox', { name: 'Работает от имени' }).click()
    await page.getByRole('option', { name: robot.name }).click()
    await expect(page.getByText('Ошибок нет')).toBeVisible()
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Правило сохранено')).toBeVisible()

    // Версии: правка — вторая версия; возврат первой — третья, «иначе» уходит
    await page.getByRole('tab', { name: 'Версии' }).click()
    await expect(page.getByText('Версия 2')).toBeVisible()
    await expect(page.getByText('Текущая')).toBeVisible()
    await page.getByRole('button', { name: 'Вернуть эту версию' }).first().click()
    const confirm = page.getByRole('alertdialog', { name: 'Вернуть версию 1?' })
    await confirm.getByRole('button', { name: 'Вернуть эту версию' }).click()
    await expect(page.getByText('Версия возвращена')).toBeVisible()
    await expect(page.getByText('Версия 3')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Добавить ветку «иначе»' })).toBeVisible()

    // Копия — выключенная, в своей вкладке
    await page.getByRole('button', { name: 'Дублировать правило' }).click()
    await expect(page.getByText('Копия правила создана — она выключена')).toBeVisible()
    await expect(page.getByRole('tab', { name: `${name} (копия)` })).toBeVisible()

    // Файл правила — и обратно импортом в пространство
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Скачать файл правила' }).click()
    const file = await (await downloading).path()
    expect(file).toBeTruthy()

    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Правила автоматизации' }).click()
    await page.getByLabel('Импорт правила').setInputFiles(file as string)
    const importing = page.getByRole('dialog', { name: 'Импорт правила из файла' })
    await expect(importing.getByText(`${name} (копия)`)).toBeVisible()
    await importing.getByRole('combobox', { name: 'Пространство' }).click()
    await page.getByRole('option').first().click()
    await importing.getByRole('button', { name: 'Импортировать' }).click()
    await expect(page.getByText('Правило импортировано')).toBeVisible()
  })

  test('правило «С нуля» создаётся: заготовка проходит проверку сервера', async ({
    page,
    request,
  }) => {
    const name = `С нуля ${Date.now().toString(36)}`
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Правила автоматизации' }).click()
    await page.getByRole('button', { name: 'Создать правило' }).click()
    const create = page.getByRole('dialog')
    await create.getByLabel('Название').fill(name)
    await create.getByRole('combobox', { name: 'Пространство' }).click()
    await page.getByRole('option').first().click()
    await create.getByRole('button', { name: 'Создать правило' }).click()
    await expect(page.getByText('Правило создано')).toBeVisible()
    await expect(page.getByRole('heading', { name })).toBeVisible()
  })
})
