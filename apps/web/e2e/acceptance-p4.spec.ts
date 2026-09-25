import { EMPLOYEE_STATE, expect, openWorkspace, test } from './fixtures.js'

/**
 * Приёмка фазы 4 (04-delivery/04-verification.md §3, сценарий D): встреча →
 * запись → расшифровка → протокол → поручения → документ → ознакомление.
 *
 * Нужен медиасервер (профиль `media` в compose) и ключи у api, иначе сценарий
 * пропускается: `KCHS_E2E_MEETINGS=1` включает его. Браузеру на хосте нужен
 * узел с достижимым адресом — `LIVEKIT_NODE_IP=127.0.0.1` в окружении compose.
 */
const ENABLED = process.env.KCHS_E2E_MEETINGS === '1'

/** Фальшивые камера и микрофон: в headless устройств нет, а поток нужен настоящий. */
const MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // Демонстрация экрана без диалога выбора окна
  '--auto-select-desktop-capture-source=Entire screen',
]

test.use({ launchOptions: { args: MEDIA_ARGS }, permissions: ['camera', 'microphone'] })

test.describe('Приёмка фазы 4: сценарий D', () => {
  test.skip(!ENABLED, 'нужен медиасервер — задайте KCHS_E2E_MEETINGS=1')

  test('встреча → запись → расшифровка → протокол → поручения → документ → ознакомление', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(600_000)
    const run = Date.now().toString(36)
    const title = `Штаб по паводку ${run}`

    await openWorkspace(page, request)

    const status = await (await request.get('/api/v1/meetings/status')).json()
    expect(status.enabled, 'медиасервер настроен').toBeTruthy()

    const csrf = (await (await request.get('/api/v1/me')).json()).session.csrfToken as string
    const headers = { 'x-csrf-token': csrf }
    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
      displayName: string
    }

    // 1. Организатор собирает встречу с участником
    const created = await request.post('/api/v1/meetings', {
      headers,
      data: { title, participantIds: [colleague.id] },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const meetingId = (await created.json()).id as string

    // 2. Оба входят в комнату
    const context = await browser.newContext({
      storageState: EMPLOYEE_STATE,
      permissions: ['camera', 'microphone'],
    })
    const colleaguePage = await context.newPage()
    await colleaguePage.goto(`/o/${meetingId}`)
    await colleaguePage.getByTestId('meeting-join').click()
    // Проверка перед входом (ADR-0162): устройства по умолчанию
    await colleaguePage.getByTestId('prejoin-join').click()
    await expect(colleaguePage.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })

    await page.goto(`/o/${meetingId}`)
    await page.getByTestId('meeting-join').click()
    // Проверка перед входом (ADR-0162): устройства по умолчанию
    await page.getByTestId('prejoin-join').click()
    await expect(page.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 })

    // 3. Запись: индикатор виден обоим участникам комнаты
    await page.getByTestId('meeting-record').click()
    await expect(page.getByTestId('meeting-recording')).toBeVisible({ timeout: 60_000 })
    await expect(colleaguePage.getByTestId('meeting-recording')).toBeVisible({ timeout: 60_000 })

    // Комнате дают записаться: Egress поднимает свой браузер, входит в комнату
    // и сводит дорожки — на это нужно больше, чем пара секунд
    await page.waitForTimeout(30_000)

    // 4. Завершение встречи останавливает запись
    await page.getByTestId('meeting-end').click()
    await expect(page.getByRole('tab', { name: 'Сведения' })).toBeVisible({ timeout: 30_000 })
    await context.close()

    // 5. Запись встречи: файл появляется в карточке, расшифровка — по модели
    const recordings = page.getByRole('list', { name: 'Записи встречи' })
    await expect(recordings).toBeVisible({ timeout: 60_000 })
    await recordings.getByRole('button').first().click()
    await expect(page.getByRole('tab', { name: /Запись|Штаб/ }).last()).toBeVisible()
    // Медиасервер догружает файл в хранилище — статус меняется сам
    await expect(page.getByText('Готова', { exact: true })).toBeVisible({ timeout: 180_000 })
    // Без модели распознавания расшифровка честно говорит, что недоступна
    await expect(
      page
        .getByText('Расшифровка недоступна')
        .or(page.getByRole('list', { name: 'Расшифровка' }))
        .first(),
    ).toBeVisible({ timeout: 60_000 })

    // 6. После встречи организатор получает дело «Проверить протокол»
    await page.goto('/inbox')
    await expect(
      page
        .getByRole('list', { name: 'Входящие' })
        .getByRole('option', { name: new RegExp(`Проверить протокол.*${run}`) })
        .first(),
    ).toBeVisible({ timeout: 60_000 })

    // 7. Протокол встречи: повестка, решение и поручение
    await page.goto(`/o/${meetingId}`)
    await page.getByRole('tab', { name: 'Протокол' }).click()
    // Протокол заводится делом после встречи; до встречи его заводят кнопкой
    const create = page.getByRole('button', { name: 'Завести протокол' })
    await expect(create.or(page.getByText('Повестка', { exact: true })).first()).toBeVisible({
      timeout: 30_000,
    })
    if (await create.isVisible()) await create.click()
    await expect(page.getByText('Повестка', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Вопрос повестки' }).click()
    const agenda = page.getByRole('article').filter({ hasText: 'Вопрос повестки' })
    await agenda.getByRole('textbox', { name: 'Вопрос повестки' }).fill('Готовность насосов')

    await page.getByRole('button', { name: 'Решение' }).click()
    const decision = page.getByRole('article').filter({ hasText: 'Решение' })
    await decision.getByRole('textbox', { name: 'Решение' }).fill('Обследовать насосы выездом')

    await page.getByRole('button', { name: 'Поручение' }).click()
    const instruction = page.getByRole('article').filter({ hasText: 'Поручение' })
    const task = `Обследовать насосные станции ${run}`
    await instruction.getByRole('textbox', { name: 'Поручение' }).fill(task)
    await instruction.getByRole('combobox', { name: 'Исполнитель' }).click()
    await page
      .getByRole('option', { name: new RegExp(colleague.displayName) })
      .first()
      .click()
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    await instruction.getByLabel('Срок').fill(due)

    // 8. Подтверждение: поручения созданы и видны со статусами
    await page.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(page.getByText(/Протокол подтверждён, создано/)).toBeVisible({ timeout: 30_000 })
    const instructions = page.getByRole('region', { name: 'Поручения протокола' })
    await expect(instructions.getByText(task)).toBeVisible()

    // 9. Регистрация документом
    await page.getByRole('button', { name: 'Зарегистрировать документом' }).click()
    const dialog = page.getByRole('dialog', { name: 'Регистрация протокола' })
    await dialog.getByRole('button', { name: 'Зарегистрировать документом' }).click()
    await expect(page.getByRole('tab', { name: 'Документ' })).toBeVisible({ timeout: 30_000 })

    // 10. Ознакомление: участник отмечает «Ознакомлен», организатор видит учёт
    await page.goto(`/o/${meetingId}`)
    await page.getByRole('tab', { name: 'Протокол' }).click()
    await page.getByRole('button', { name: 'Отправить на ознакомление' }).click()
    await expect(page.getByText(/Ознакомление запрошено/)).toBeVisible({ timeout: 30_000 })

    const employee = await browser.newContext({ storageState: EMPLOYEE_STATE })
    const employeePage = await employee.newPage()
    await employeePage.goto(`/o/${meetingId}`)
    await employeePage.getByRole('tab', { name: 'Протокол' }).click()
    await expect(employeePage.getByText('Вас просят ознакомиться с протоколом')).toBeVisible({
      timeout: 30_000,
    })
    await employeePage.getByRole('button', { name: 'Ознакомлен' }).click()
    await expect(employeePage.getByText('Отметка об ознакомлении поставлена')).toBeVisible()
    await employee.close()

    await page.reload()
    await page.getByRole('tab', { name: 'Протокол' }).click()
    await expect(page.getByTestId('protocol-ack-summary')).toContainText('1', { timeout: 30_000 })
  })
})

/**
 * Приёмка фазы 4, критерий 2 (04-verification.md §3): канал подразделения,
 * тред, поиск по сообщениям и поручение из сообщения. Личный звонок из беседы
 * с демонстрацией экрана проверяется отдельно — ему нужен медиасервер.
 */
test.describe('Приёмка фазы 4: мессенджер', () => {
  test('канал подразделения, тред, поиск и поручение из сообщения', async ({ page, request }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    await openWorkspace(page, request)

    await page.getByRole('button', { name: 'Чаты' }).first().click()
    await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible()

    // Канал подразделения: заводится вместе с пространством (ADR-0090)
    await page.getByRole('tab', { name: 'Каналы' }).click()
    const channels = page.getByRole('list', { name: 'Чаты' })
    await expect(channels.getByRole('listitem').first()).toBeVisible({ timeout: 20_000 })
    await channels.getByRole('listitem').first().getByRole('button').first().click()

    const text = `Сводка по паводку ${run}`
    await page.getByLabel('Сообщение…').fill(text)
    await page.getByRole('button', { name: 'Отправить' }).click()
    const message = page.getByRole('article').filter({ hasText: text })
    await expect(message).toBeVisible()

    // Тред: ответ уходит в ветку сообщения, а не в ленту канала
    const row = page.getByRole('listitem').filter({ has: message }).first()
    await row.hover()
    await row.getByRole('button', { name: 'Действия с сообщением' }).click()
    await page.getByRole('menuitem', { name: 'Ответить в треде' }).click()
    const thread = page.getByRole('complementary', { name: 'Тред' })
    await expect(thread).toBeVisible()
    await thread.getByLabel('Ответ в треде…').fill(`Насосы готовы ${run}`)
    await thread.getByRole('button', { name: 'Отправить' }).click()
    await expect(thread.getByText(`Насосы готовы ${run}`)).toBeVisible()
    await thread.getByRole('button', { name: 'Закрыть' }).click()
    await expect(thread).toBeHidden()

    // Поиск по сообщениям канала
    await page.getByRole('button', { name: 'Поиск сообщений' }).click()
    await page.getByRole('searchbox', { name: 'Поиск сообщений' }).fill(`Сводка по паводку ${run}`)
    await expect(page.getByRole('list', { name: 'Поиск сообщений' })).toContainText('паводку')
    await page.getByRole('button', { name: 'Поиск сообщений' }).click()

    // Поручение из сообщения: цитата уходит в описание
    await row.hover()
    await row.getByRole('button', { name: 'Действия с сообщением' }).click()
    await page.getByRole('menuitem', { name: 'Создать поручение' }).click()
    const task = page.getByRole('dialog')
    await task.getByLabel('Что сделать').fill(`Свести сводку ${run}`)
    await task.getByRole('searchbox', { name: 'Исполнитель' }).fill('user001')
    await task.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
    await task.getByRole('button', { name: 'Создать поручение' }).click()
    await expect(page.getByText(/Поручение .+ создано/)).toBeVisible()
  })
})

/**
 * Приёмка фазы 4, критерий 2 (продолжение): личный звонок из беседы с
 * демонстрацией экрана. Нужен медиасервер — иначе сценарий пропускается.
 */
test.describe('Приёмка фазы 4: звонок из беседы', () => {
  test.skip(!ENABLED, 'нужен медиасервер — задайте KCHS_E2E_MEETINGS=1')

  test('личный звонок из беседы, оба в комнате, демонстрация экрана', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(240_000)
    const run = Date.now().toString(36)
    await openWorkspace(page, request)

    // Собеседник ждёт звонка в оболочке
    const context = await browser.newContext({
      storageState: EMPLOYEE_STATE,
      permissions: ['camera', 'microphone'],
    })
    const colleaguePage = await context.newPage()
    await colleaguePage.goto('/')
    await expect(colleaguePage.getByRole('tab').first()).toBeVisible({ timeout: 20_000 })

    // Личная беседа и звонок из её шапки
    await page.getByRole('button', { name: 'Чаты' }).first().click()
    await page.getByRole('button', { name: 'Новая беседа' }).click()
    const create = page.getByRole('dialog')
    await create.getByRole('searchbox', { name: 'Собеседник' }).fill('user001')
    await create.getByRole('list', { name: 'Собеседник' }).getByRole('button').first().click()
    await create.getByRole('button', { name: 'Создать' }).click()
    await expect(create).toBeHidden()

    await page.getByLabel('Сообщение…').fill(`Созвон ${run}`)
    await page.getByRole('button', { name: 'Отправить' }).click()
    await page.getByRole('button', { name: 'Позвонить' }).click()

    // Организатор входит в комнату из вкладки встречи
    await page.getByTestId('meeting-join').click()
    // Проверка перед входом (ADR-0162): устройства по умолчанию
    await page.getByTestId('prejoin-join').click()
    await expect(page.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })

    // Собеседник принимает входящий и входит
    const incoming = colleaguePage.getByTestId('incoming-call')
    await expect(incoming).toBeVisible({ timeout: 30_000 })
    await incoming.getByTestId('call-accept').click()
    await colleaguePage.getByTestId('meeting-join').click()
    // Проверка перед входом (ADR-0162): устройства по умолчанию
    await colleaguePage.getByTestId('prejoin-join').click()
    await expect(colleaguePage.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 })

    // Демонстрация экрана: собеседник видит дорожку экрана
    await page.getByTestId('meeting-share').click()
    await expect(colleaguePage.getByText(/Экран:/)).toBeVisible({ timeout: 30_000 })

    await page.getByTestId('meeting-leave').click()
    await context.close()
  })
})
