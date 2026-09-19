import { expect, openScreen, openWorkspace, test } from './fixtures.js'

test.describe('Оболочка рабочего пространства', () => {
  test('вход и стартовый экран «Мой день»', async ({ page, request }) => {
    await openWorkspace(page, request)

    await expect(page.getByRole('heading', { name: /Доброе|Добрый/ })).toBeVisible()
    await expect(page.getByText('Входящие', { exact: true }).first()).toBeVisible()
    // Строка состояния показывает соединение realtime
    await expect(page.getByText('На связи')).toBeVisible({ timeout: 15_000 })
  })

  test('палитра команд открывает экраны', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Файлы')

    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Новая папка' })).toBeVisible()
  })

  test('вкладки: предпросмотр, закрепление, закрытие и восстановление', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Пространства')
    await expect(page.getByRole('tab', { name: /Пространства/ })).toBeVisible()

    await page.keyboard.press('Meta+w')
    await expect(page.getByRole('tab', { name: /Пространства/ })).toHaveCount(0)

    await page.keyboard.press('Meta+Shift+t')
    await expect(page.getByRole('tab', { name: /Пространства/ })).toBeVisible()
  })

  test('разделение панелей и восстановление состояния после перезагрузки', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)

    await openScreen(page, 'Файлы')
    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()

    await page.keyboard.press('Meta+\\')
    await expect(page.getByRole('tablist')).toHaveCount(2)

    // Состояние сохраняется с дебаунсом и досылается при уходе со страницы
    await page.waitForTimeout(3000)
    await page.reload()
    await expect(page.getByRole('tablist')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.getByRole('tab', { name: /Файлы/ })).toBeVisible()
  })

  test('панели сворачиваются с клавиатуры', async ({ page, request }) => {
    await openWorkspace(page, request)

    const navigator = page.getByRole('complementary', { name: 'Навигатор' })
    await expect(navigator).toBeVisible()
    await page.keyboard.press('Meta+b')
    await expect(navigator).toBeHidden()
    await page.keyboard.press('Meta+b')
    await expect(navigator).toBeVisible()
  })

  test('шпаргалка горячих клавиш', async ({ page, request }) => {
    await openWorkspace(page, request)
    await page.keyboard.press('Shift+?')
    await expect(page.getByRole('dialog').getByText('Горячие клавиши')).toBeVisible()
    await expect(page.getByText('Палитра команд')).toBeVisible()
  })

  test('переключение темы через палитру', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Тёмная')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  test('две вкладки одного типа не делят состояние: секция и форма карточки', async ({
    page,
    request,
  }) => {
    // Две служебные записки — вкладки одного представления «Документ»
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const types = (await (await request.get('/api/v1/document-types')).json()).items as Array<{
      id: string
      key: string
    }>
    const run = Date.now().toString(36)
    const [first, second] = [`Первая записка ${run}`, `Вторая записка ${run}`]
    const ids: string[] = []
    for (const subject of [first, second]) {
      const created = await request.post('/api/v1/documents', {
        headers,
        data: { typeId: types.find((type) => type.key === 'memo')?.id, subject },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      ids.push((await created.json()).id as string)
    }

    await openWorkspace(page, request)
    await page.goto(`/o/${ids[0]}`)
    await expect(page.getByRole('heading', { name: first })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('tab', { name: 'История', exact: true }).click()
    await page.goto(`/o/${ids[1]}`)
    await expect(page.getByRole('heading', { name: second })).toBeVisible({ timeout: 20_000 })
    const sections = page.getByRole('tablist', { name: 'Разделы карточки' })
    await expect(sections.getByRole('tab', { selected: true })).toHaveText('Карточка')

    // Первая вкладка — на своей секции и со своей карточкой, без чужих правок
    await page.getByRole('tab', { name: new RegExp(first) }).click()
    await expect(page.getByRole('heading', { name: first })).toBeVisible()
    await expect(sections.getByRole('tab', { selected: true })).toHaveText('История')
    await sections.getByRole('tab', { name: 'Карточка', exact: true }).click()
    const card = page.getByRole('tabpanel', { name: 'Карточка' })
    await expect(card.getByRole('textbox', { name: 'Тема' })).toHaveValue(first)
    await expect(card.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()
  })
})
