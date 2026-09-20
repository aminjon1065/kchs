import { request as playwrightRequest } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openScreen, openWorkspace, test } from './fixtures.js'

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'

/**
 * Приёмка фазы 5 (04-delivery/04-verification.md §3), сценарий A «Паводок» —
 * звенья, которые появились в этой фазе: показатель → алерт → правило
 * автоматизации → сообщение в канале «Оперативный штаб» и встреча-совещание.
 *
 * Начало цепочки (импорт файла, карта рядом с таблицей, дашборд) принято в
 * фазах 1–2, продолжение (встреча → запись → протокол → поручения) — в приёмке
 * фазы 4: здесь они не повторяются.
 */
test.describe('Приёмка фазы 5: сценарий A — от показателя к совещанию', () => {
  test('алерт срабатывает → правило пишет в канал и созывает совещание', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const alertName = `Паводок ${run}`
    const meetingTitle = `Совещание по паводку ${run}`

    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    // 1. Уровни воды по гидропостам: два поста из трёх выше критического
    const dataset = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Уровни воды ${run}`,
        spaceId,
        fields: [
          { key: 'post', label: { ru: 'Гидропост' }, type: 'text', semantic: 'category' },
          { key: 'level', label: { ru: 'Уровень, см' }, type: 'integer' },
          { key: 'critical', label: { ru: 'Критический, см' }, type: 'integer' },
        ],
      },
    })
    expect(dataset.ok(), await dataset.text()).toBeTruthy()
    const datasetId = (await dataset.json()).id as string
    const rows = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: [
          { values: { post: `Пяндж ${run}`, level: 420, critical: 380 } },
          { values: { post: `Вахш ${run}`, level: 505, critical: 450 } },
          { values: { post: `Кафирниган ${run}`, level: 210, critical: 400 } },
        ],
      },
    })
    expect(rows.ok(), await rows.text()).toBeTruthy()

    // 2. Показатель «Постов выше отметки 400 см» (два поста из трёх)
    const metricName = `Постов выше отметки ${run}`
    const metric = await request.post('/api/v1/metrics', {
      headers,
      data: {
        name: metricName,
        spaceId,
        datasetId,
        definition: {
          measure: { agg: 'count' },
          filter: { field: 'level', op: 'gt', value: 400 },
          period: null,
          comparison: 'none',
        },
      },
    })
    expect(metric.ok(), await metric.text()).toBeTruthy()
    const metricId = (await metric.json()).id as string

    // 3. Правило: событие алерта → сообщение в канале и совещание в календаре.
    // Правило работает от служебного пользователя (ADR-0096: администратором
    // системы — нельзя), поэтому канал берётся из видимых и ему, и проверяющему
    const employee = await playwrightRequest.newContext({
      baseURL: BASE,
      storageState: EMPLOYEE_STATE,
    })
    const serviceUser = (await (await employee.get('/api/v1/me')).json()).user as { id: string }
    const staffChannel = await request.post('/api/v1/chats', {
      headers,
      data: {
        kind: 'channel',
        title: `Оперативный штаб ${run}`,
        spaceId,
        memberIds: [serviceUser.id],
      },
    })
    expect(staffChannel.ok(), await staffChannel.text()).toBeTruthy()
    const channel = (await staffChannel.json()) as { id: string; title: string }

    const rule = await request.post('/api/v1/automation/rules', {
      headers,
      data: {
        spaceId,
        definition: {
          name: { ru: `Оперативный штаб ${run}` },
          enabled: true,
          runAs: serviceUser.id,
          trigger: { kind: 'event', type: 'alert.fired' },
          actions: [
            {
              type: 'post_message',
              conversation: channel.id,
              text: `Паводок: сработал алерт «${alertName}»`,
            },
            {
              type: 'create_event',
              title: meetingTitle,
              startsAt: '{{now}}',
              durationMinutes: 30,
              participants: [`user:${serviceUser.id}`],
            },
          ],
        },
      },
    })
    expect(rule.ok(), await rule.text()).toBeTruthy()
    const ruleId = (await rule.json()).id as string

    try {
      // 4. Алерт на показатель: порог «больше одного поста»
      await openWorkspace(page, request)
      await openScreen(page, 'Алерты')
      await page.getByRole('button', { name: 'Создать алерт' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Название').fill(alertName)
      await dialog.getByRole('combobox', { name: 'Пространство' }).click()
      await page.getByRole('option').first().click()
      await dialog.getByRole('combobox', { name: 'Показатель' }).click()
      await page.getByRole('option', { name: metricName }).click()
      await dialog.getByRole('button', { name: 'Создать алерт' }).click()
      await expect(page.getByText('Алерт создан')).toBeVisible()

      await page.getByRole('spinbutton', { name: 'Порог' }).fill('1')
      await page.getByRole('button', { name: 'Сохранить' }).click()
      await expect(page.getByText('Алерт сохранён')).toBeVisible()

      // 5. Проверка сейчас: два поста выше критического — алерт срабатывает
      await page.getByRole('button', { name: 'Проверить сейчас' }).click()
      await expect(page.getByText(/выше порога 1/)).toBeVisible({ timeout: 30_000 })

      // 6. Правило отработало: сообщение в канале и совещание в календаре
      await expect
        .poll(
          async () => {
            const runs = await request.get(`/api/v1/automation/rules/${ruleId}/runs?limit=5`)
            const items = (await runs.json()).items as Array<{ status: string }>
            return items.filter((item) => item.status === 'succeeded').length
          },
          { timeout: 60_000, message: 'правило запустилось по событию алерта' },
        )
        .toBeGreaterThan(0)

      const events = await request.get(
        `/api/v1/objects?type=event&q=${encodeURIComponent(meetingTitle)}&limit=5`,
      )
      expect((await events.json()).items.length, 'совещание создано правилом').toBeGreaterThan(0)

      // Сообщение видно в канале — руководитель узнаёт о паводке там, где работает
      // Чаты открываются с рейки: в палитре «Чаты» есть и одноимённые беседы
      await page.getByRole('button', { name: 'Чаты', exact: true }).first().click()
      await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible()
      await page
        .getByRole('list', { name: 'Чаты' })
        .getByRole('button', { name: new RegExp(channel.title) })
        .first()
        .click()
      await expect(page.getByText(`Паводок: сработал алерт «${alertName}»`)).toBeVisible({
        timeout: 30_000,
      })
    } finally {
      await employee.dispose()
      // Сценарий убирает за собой: правило и алерт на общем стенде не нужны
      await request.patch(`/api/v1/automation/rules/${ruleId}/enabled`, {
        headers,
        data: { enabled: false },
      })
      await request.delete(`/api/v1/objects/${ruleId}`, { headers })
      const list = await request.get('/api/v1/alerts?limit=200')
      const alert = ((await list.json()).items as Array<{ id: string; name: string }>).find(
        (item) => item.name === alertName,
      )
      if (alert) await request.delete(`/api/v1/objects/${alert.id}`, { headers })
      await request.delete(`/api/v1/objects/${metricId}`, { headers })
      await request.delete(`/api/v1/objects/${datasetId}`, { headers })
      await request.delete(`/api/v1/objects/${channel.id}`, { headers })
    }
  })
})

/**
 * Сценарий C «Ежемесячный отчёт руководству» — звено фазы 5: готовый отчёт
 * становится исходящим документом (ADR-0127), и дальше им занимается обычная
 * канцелярия. Расписание источников, показатели и дашборд приняты в фазах 1–2,
 * согласование и подпись — в фазе 3.
 */
test.describe('Приёмка фазы 5: сценарий C — отчёт руководству', () => {
  test('построенный отчёт становится исходящим документом с файлом первой версией', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const reportName = `Сводка за месяц ${run}`

    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    // Отчёт из шаблона и его построение — обычным путём фазы 2
    const report = await request.post('/api/v1/reports', {
      headers,
      data: { name: reportName, spaceId },
    })
    expect(report.ok(), await report.text()).toBeTruthy()
    const reportId = (await report.json()).id as string

    try {
      const started = await request.post(`/api/v1/reports/${reportId}/runs`, {
        headers,
        data: { formats: ['pdf'] },
      })
      expect(started.ok(), await started.text()).toBeTruthy()
      await expect
        .poll(
          async () => {
            const runs = await request.get(`/api/v1/reports/${reportId}/runs`)
            const items = (await runs.json()).items as Array<{ status: string }>
            return items[0]?.status ?? 'queued'
          },
          { timeout: 120_000, message: 'отчёт построен движком' },
        )
        .toBe('succeeded')

      // Отчёт → исходящий документ: вид выбирается в диалоге
      await openWorkspace(page, request)
      await page.goto(`/o/${reportId}`)
      await page.getByRole('button', { name: 'В документ' }).click()
      const dialog = page.getByRole('dialog', { name: 'Отчёт исходящим документом' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('combobox', { name: 'Выберите вид исходящего' }).click()
      await page.getByRole('option').first().click()
      await dialog.getByRole('button', { name: 'Создать документ' }).click()
      await expect(page.getByText('Документ создан из отчёта')).toBeVisible({ timeout: 30_000 })

      // Документ открылся своей вкладкой рядом с отчётом — обе зовутся одинаково
      await expect(page.getByRole('tab', { name: new RegExp(reportName) })).toHaveCount(2)
      await page.getByRole('tab', { name: 'Версии' }).click()
      await expect(page.getByText(/\.pdf/).first()).toBeVisible({ timeout: 20_000 })
    } finally {
      await request.delete(`/api/v1/objects/${reportId}`, { headers })
    }
  })
})

/**
 * Сценарий G «Новый сотрудник и замещение»: учётная запись с подразделением и
 * должностью, стартовая страница базы знаний из сида, задача адаптации
 * правилом автоматизации по событию `user.created`, замещение на период
 * отпуска. Действия «от имени» приняты в фазе 0 (сценарий №6).
 */
test.describe('Приёмка фазы 5: сценарий G — новый сотрудник', () => {
  test('новичок получает задачу адаптации правилом и находит руководство', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const me = await (await request.get('/api/v1/me')).json()
    const headers = { 'x-csrf-token': me.session.csrfToken as string }
    const login = `newbie-${run}`

    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
    const units = (await (await request.get('/api/v1/org/units')).json()).items as Array<{
      id: string
      name: { ru: string }
    }>
    const unit = units[0]
    expect(unit, 'в оргструктуре есть подразделение').toBeTruthy()

    // Правило работает от служебного пользователя: администратором системы — нельзя
    const employee = await playwrightRequest.newContext({
      baseURL: BASE,
      storageState: EMPLOYEE_STATE,
    })
    const serviceUser = (await (await employee.get('/api/v1/me')).json()).user as { id: string }
    await employee.dispose()

    // Стартовая страница руководства — она же источник поручения адаптации
    const pages = await request.get(
      `/api/v1/objects?type=page&q=${encodeURIComponent('Как работать в kchs')}&limit=5`,
    )
    const guide = ((await pages.json()).items as Array<{ id: string; title: string }>)[0]
    expect(guide, 'руководство пользователя заведено сидом').toBeTruthy()

    // Правило адаптации: новому сотруднику — поручение прочитать руководство
    const rule = await request.post('/api/v1/automation/rules', {
      headers,
      data: {
        spaceId,
        definition: {
          name: { ru: `Адаптация нового сотрудника ${run}` },
          enabled: true,
          runAs: serviceUser.id,
          trigger: { kind: 'event', type: 'user.created' },
          actions: [
            {
              type: 'create_task',
              title: `Ознакомиться с руководством ${run}`,
              assignee: 'user:{{object.id}}',
              dueWorkingDays: 3,
              source: guide?.id ?? '',
            },
          ],
        },
      },
    })
    expect(rule.ok(), await rule.text()).toBeTruthy()
    const ruleId = (await rule.json()).id as string

    let userId = ''
    try {
      const created = await request.post('/api/v1/users', {
        headers,
        data: {
          login,
          email: `${login}@example.org`,
          lastName: 'Новиков',
          firstName: `Новичок${run}`,
          unitId: unit?.id,
          roleKeys: ['employee'],
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      userId = (await created.json()).id as string

      // Правило отработало: у новичка есть поручение
      await expect
        .poll(
          async () => {
            const runs = await request.get(`/api/v1/automation/rules/${ruleId}/runs?limit=5`)
            const items = (await runs.json()).items as Array<{ status: string }>
            return items.filter((item) => item.status === 'succeeded').length
          },
          { timeout: 60_000, message: 'правило адаптации сработало на нового сотрудника' },
        )
        .toBeGreaterThan(0)

      const tasks = await request.get(
        `/api/v1/objects?type=task&q=${encodeURIComponent(`Ознакомиться с руководством ${run}`)}&limit=5`,
      )
      expect((await tasks.json()).items.length, 'поручение адаптации создано').toBeGreaterThan(0)

      // Стартовая страница базы знаний на месте: руководство приезжает с сидом
      await openWorkspace(page, request)
      await page.goto(`/o/${guide?.id}`)
      await expect(page.getByRole('tab', { name: /Как работать в kchs/ })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('navigation', { name: 'Оглавление' })).toBeVisible({
        timeout: 20_000,
      })
    } finally {
      await request.patch(`/api/v1/automation/rules/${ruleId}/enabled`, {
        headers,
        data: { enabled: false },
      })
      await request.delete(`/api/v1/objects/${ruleId}`, { headers })
      // Новичок остаётся, но заблокирован: удалять людей платформа не даёт
      if (userId) {
        await request.patch(`/api/v1/users/${userId}`, { headers, data: { status: 'blocked' } })
      }
    }
  })
})
