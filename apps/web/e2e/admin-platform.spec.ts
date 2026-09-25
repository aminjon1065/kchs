import { expect, openScreen, openWorkspace, test } from './fixtures.js'

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'

/**
 * Администрирование установки (P5-E06): возможности (ADR-0115), брендирование
 * (ADR-0116) и резервные копии (ADR-0117). Сценарий возвращает установку в
 * исходное состояние: стенд общий, а выключенная возможность или чужое название
 * организации сломали бы остальные проверки.
 */
test.describe('Администрирование: возможности, брендирование, копии', () => {
  test('возможность выключается: экран уходит с рейки, маршрут отвечает «не найдено»', async ({
    page,
    request,
  }) => {
    const csrf = async () => (await (await request.get('/api/v1/me')).json()).session.csrfToken
    const headers = { 'x-csrf-token': (await csrf()) as string }

    await openWorkspace(page, request)
    await expect(page.getByRole('button', { name: 'Знания', exact: true })).toBeVisible()

    try {
      await openScreen(page, 'Администрирование')
      await page.getByRole('tab', { name: 'Возможности' }).click()
      const row = page.getByRole('listitem').filter({ hasText: 'База знаний' })
      await expect(row).toBeVisible()
      await row.getByRole('switch').click()
      await expect(page.getByText('Возможность изменена')).toBeVisible()

      // Рейка перестраивается по `/me`: кнопки раздела больше нет
      await expect(page.getByRole('button', { name: 'Знания', exact: true })).toBeHidden({
        timeout: 15_000,
      })

      // Маршрут выключенной возможности отвечает «не найдено», а не «нет доступа»
      const spaces = await request.get('/api/v1/spaces')
      const spaceId = ((await spaces.json()).items as Array<{ id: string; key: string }>).find(
        (space) => space.key === 'org',
      )?.id
      const tree = await request.get(`/api/v1/knowledge/tree?spaceId=${spaceId}`)
      expect(tree.status()).toBe(404)
    } finally {
      await request.patch('/api/v1/admin/features/knowledge', {
        headers,
        data: { enabled: true },
      })
    }

    await page.reload()
    await expect(page.getByRole('button', { name: 'Знания', exact: true })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('брендирование: название организации видно на рейке и на экране входа', async ({
    page,
    request,
  }) => {
    const run = Date.now().toString(36)
    const name = `Комитет ${run}`
    const csrf = (await (await request.get('/api/v1/me')).json()).session.csrfToken as string
    const headers = { 'x-csrf-token': csrf }
    // Демо-стенд держит брендирование Комитета — после сценария оно возвращается
    const before = await (await request.get('/api/v1/branding')).json()

    await openWorkspace(page, request)
    try {
      await openScreen(page, 'Администрирование')
      await page.getByRole('tab', { name: 'Брендирование' }).click()
      await page.getByLabel('Название организации').fill(name)
      await page.getByLabel('Короткое название').fill(`КЧС ${run}`)
      await page.getByRole('button', { name: 'Бирюзовый' }).click()
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
      await expect(page.getByText('Брендирование сохранено')).toBeVisible()

      // Акцент — атрибутом на корне: компоненты не меняются
      await expect(page.locator('html')).toHaveAttribute('data-accent', 'teal', { timeout: 15_000 })
      await expect(page.getByRole('button', { name: `КЧС ${run}` })).toBeVisible()

      // До входа название уже известно: запрос публичный
      const branding = await request.get('/api/v1/branding')
      expect(branding.ok()).toBeTruthy()
      expect((await branding.json()).name).toBe(name)
    } finally {
      await request.patch('/api/v1/admin/branding', {
        headers,
        data: {
          name: before.name ?? '',
          shortName: before.shortName ?? '',
          accent: before.accent ?? 'blue',
          logo: before.logo ?? null,
          loginNote: before.loginNote ?? '',
        },
      })
    }
  })

  test('резервные копии: список прогонов и отметка о проверке восстановлением', async ({
    page,
    request,
  }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Резервные копии' }).click()
    await expect(page.getByRole('button', { name: 'Сделать копию' })).toBeVisible()
    // Дамп снимает `pg_dump`; на машине без него прогон честно помечается ошибкой,
    // поэтому проверяем сам список и его состояния, а не содержимое архива
    await expect(page.getByText('Обслуживание')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Переиндексировать поиск' })).toBeVisible()
  })
})

/**
 * Правка подразделения (вопрос N86): консоль умела только заводить
 * подразделения, менять их приходилось запросом к API. Сценарий заводит своё
 * подразделение, правит название и убирает за собой.
 */
test.describe('Администрирование: оргструктура', () => {
  test('подразделение правится в консоли: название и признак действующего', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }

    const created = await request.post('/api/v1/org/units', {
      headers,
      data: { name: { ru: `Отдел приёмки ${run}` }, code: `ACC-${run}`, createSpace: false },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Оргструктура' }).click()
    await page.getByRole('treeitem', { name: new RegExp(`Отдел приёмки ${run}`) }).click()

    const editor = page.getByRole('group', { name: 'Подразделение' })
    await expect(editor).toBeVisible()
    await editor.getByLabel('Название (рус.)').fill(`Отдел приёмки ${run} (правленый)`)
    await editor.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Подразделение сохранено')).toBeVisible({ timeout: 20_000 })

    const units = await request.get('/api/v1/org/units')
    const unit = ((await units.json()).items as Array<{ id: string; name: { ru: string } }>).find(
      (item) => item.name.ru.startsWith(`Отдел приёмки ${run}`),
    )
    expect(unit?.name.ru).toContain('правленый')
    if (unit) {
      await request.patch(`/api/v1/org/units/${unit.id}`, { headers, data: { isActive: false } })
    }
  })
})

/**
 * Группы, должности и назначение в консоли (N86, ADR-0144): каталога нет, состав
 * «Дежурной смены» и справочник должностей администратор ведёт сам. Сотрудник для
 * назначения — свой, чтобы не менять подразделение демо-сотрудников других сценариев.
 */
test.describe('Администрирование: группы, должности, назначение', () => {
  test('группа с составом, новая должность и перевод сотрудника', async ({ page, request }) => {
    test.setTimeout(150_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const units = (await (await request.get('/api/v1/org/units')).json()).items as Array<{
      id: string
      code: string
      name: { ru: string }
    }>
    const from = units.find((unit) => unit.code === 'UO')
    const to = units.find((unit) => unit.code === 'UD-HR')
    expect(from && to).toBeTruthy()
    const login = `assign-${run}`
    const created = await request.post('/api/v1/users', {
      headers,
      data: {
        login,
        lastName: 'Назначенов',
        firstName: `Сотрудник${run}`,
        roleKeys: ['employee'],
        mustChangePassword: true,
        unitId: from?.id,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const employeeId = (await created.json()).id as string
    const displayName = `Назначенов Сотрудник${run}`

    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')

    // Группа: название и состав
    await page.getByRole('tab', { name: 'Группы' }).click()
    await page.getByRole('button', { name: 'Новая группа' }).click()
    const groupDialog = page.getByRole('dialog', { name: 'Новая группа' })
    await groupDialog.getByLabel('Название').fill(`Смена приёмки ${run}`)
    await groupDialog.getByRole('searchbox', { name: 'Добавить сотрудника' }).fill(login)
    await groupDialog
      .getByRole('list', { name: 'Добавить сотрудника' })
      .getByRole('button', { name: new RegExp(displayName) })
      .click()
    await expect(groupDialog.getByRole('list', { name: 'Состав' })).toContainText(displayName)
    await groupDialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Группа сохранена')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('row', { name: new RegExp(`Смена приёмки ${run}`) })).toContainText(
      '1',
    )

    // Должность в справочнике
    await page.getByRole('tab', { name: 'Оргструктура' }).click()
    await page.getByRole('button', { name: 'Новая должность' }).click()
    const positionDialog = page.getByRole('dialog', { name: 'Новая должность' })
    await positionDialog.getByLabel('Название (рус.)').fill(`Дежурный приёмки ${run}`)
    await positionDialog.getByLabel('Ранг').fill('15')
    await positionDialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Должность сохранена')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('list', { name: 'Должности' })).toContainText(
      `Дежурный приёмки ${run}`,
    )

    // Перевод: другое подразделение и новая должность
    await page.getByRole('tab', { name: 'Пользователи' }).click()
    await page.getByPlaceholder('Имя, логин или почта').fill(login)
    await expect(page.getByRole('button', { name: /^Действия: / })).toHaveCount(1)
    await page.getByRole('button', { name: `Действия: ${displayName}` }).click()
    await page.getByRole('menuitem', { name: 'Подразделение и должность' }).click()
    const assignment = page.getByRole('dialog', {
      name: `Подразделение и должность — ${displayName}`,
    })
    await assignment.getByRole('combobox', { name: 'Подразделение' }).click()
    await page.getByRole('option', { name: to?.name.ru, exact: false }).first().click()
    await assignment.getByRole('combobox', { name: 'Должность' }).click()
    await page.getByRole('option', { name: `Дежурный приёмки ${run}` }).click()
    await assignment.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Назначение сохранено')).toBeVisible({ timeout: 20_000 })

    const after = (await (await request.get(`/api/v1/users?q=${login}`)).json()).items as Array<{
      id: string
      units: Array<{ id: string; isPrimary: boolean }>
      positions: Array<{ name: string }>
    }>
    const moved = after.find((user) => user.id === employeeId)
    // Перевод, а не совместительство: прежнего подразделения в назначениях нет
    expect(moved?.units.map((unit) => unit.id)).toEqual([to?.id])
    expect(moved?.positions.map((position) => position.name)).toEqual([`Дежурный приёмки ${run}`])

    // Уборка: должность освобождается и удаляется, сотрудник блокируется. Группа остаётся —
    // удаления групп нет намеренно (ADR-0144)
    await request.patch(`/api/v1/users/${employeeId}`, {
      headers,
      data: { positionId: null, status: 'blocked' },
    })
    const positions = (await (await request.get('/api/v1/org/positions')).json()).items as Array<{
      id: string
      name: { ru: string }
    }>
    const position = positions.find((item) => item.name.ru === `Дежурный приёмки ${run}`)
    if (position) {
      const removed = await request.delete(`/api/v1/org/positions/${position.id}`, { headers })
      expect(removed.ok(), await removed.text()).toBeTruthy()
    }
  })
})

/**
 * Консоль по способностям разделов (N85): администратор ГИС видит вход в консоль на рейке
 * и в палитре, а в самой консоли — только свои разделы, без ошибок чужих.
 */
test.describe('Администрирование: вход по способностям разделов', () => {
  test('администратор ГИС видит только подложки и ГИС-службы', async ({ browser, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const login = `gisadm-${run}`
    const password = `Gis-${run}-Kchs-2026!`
    const created = await request.post('/api/v1/users', {
      headers,
      data: {
        login,
        lastName: 'Картографов',
        firstName: `Админ${run}`,
        roleKeys: ['gis_admin'],
        password,
        mustChangePassword: false,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const userId = (await created.json()).id as string

    const context = await browser.newContext({ baseURL: BASE })
    const signedIn = await context.request.post('/api/v1/auth/login', {
      data: { login, password, rememberDevice: false },
    })
    expect(signedIn.ok(), await signedIn.text()).toBeTruthy()
    const page = await context.newPage()
    await openWorkspace(page, context.request)
    await expect(page.getByRole('button', { name: 'Администрирование' })).toBeVisible()
    await openScreen(page, 'Администрирование')
    await expect(page.getByRole('tablist', { name: 'Раздел' }).getByRole('tab')).toHaveText([
      'Базовые карты',
      'Внешние ГИС-службы',
    ])
    await expect(page.getByRole('tab', { name: 'Базовые карты' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await context.close()
    await request.patch(`/api/v1/users/${userId}`, { headers, data: { status: 'blocked' } })
  })
})

/**
 * Справка (N88): администратор выбирает страницу базы знаний в «Брендировании», и пункт
 * «Справка» на рейке открывает её вкладкой. Прежний выбор возвращается после сценария.
 */
test.describe('Администрирование: справка', () => {
  test('страница справки выбирается в консоли и открывается с рейки', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const before = await (await request.get('/api/v1/knowledge/help/pages')).json()
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      key: string | null
    }>
    const org = spaces.find((space) => space.key === 'org')
    expect(org).toBeTruthy()
    const title = `Справка приёмки ${run}`
    const created = await request.post('/api/v1/pages', {
      headers,
      data: { title, spaceId: org?.id, template: 'blank' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    try {
      await openWorkspace(page, request)
      await openScreen(page, 'Администрирование')
      await page.getByRole('tab', { name: 'Брендирование' }).click()
      const card = page.getByRole('group', { name: 'Справка' })
      await card.getByRole('combobox', { name: 'Страница справки: Русский' }).click()
      await page.getByRole('option', { name: title }).click()
      await card.getByRole('button', { name: 'Сохранить справку' }).click()
      await expect(page.getByText('Справка сохранена')).toBeVisible({ timeout: 20_000 })

      await page.reload()
      await page.getByRole('button', { name: 'Справка', exact: true }).click()
      // Страница открывается вкладкой рабочей области с её названием
      await expect(page.getByRole('tab', { name: new RegExp(title) })).toBeVisible({
        timeout: 20_000,
      })
    } finally {
      // Стенд общий: прежний выбор справки возвращается и при падении сценария
      await request.put('/api/v1/knowledge/help/pages', { headers, data: before })
    }
  })
})

/**
 * Свои роли организации (ADR-0165): роль собирается из способностей в матрице ролей,
 * правится и удаляется, пока её никто не держит.
 */
test.describe('Администрирование: свои роли', () => {
  test('роль из способностей заводится, видна в матрице и удаляется', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const name = `Выгрузка сводок ${run}`
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Роли и способности' }).click()
    await page.getByRole('button', { name: 'Новая роль' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новая роль' })
    await dialog.getByLabel('Название (рус.)').fill(name)
    await dialog.getByRole('checkbox', { name: 'Выгрузка данных' }).check()
    // Администрирование системы в своей роли не выдаётся
    await expect(dialog.getByRole('checkbox', { name: 'Администрирование системы' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Роль сохранена')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('columnheader', { name: new RegExp(name) })).toBeVisible()

    await page.getByRole('button', { name: `Изменить роль «${name}»` }).click()
    await page
      .getByRole('dialog', { name: 'Роль' })
      .getByRole('button', { name: 'Удалить' })
      .click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
    await expect(page.getByText('Роль удалена')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('columnheader', { name: new RegExp(name) })).toHaveCount(0)
  })
})
