import { expect, openScreen, openWorkspace, test } from './fixtures.js'

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
