import { expect, test } from './fixtures.js'

const EMPLOYEE_LOGIN = 'user001'

/**
 * Протокол встречи (P4-E02 S07, ADR-0093, сценарий D фазы 4): организатор
 * заводит повестку до встречи, после встречи дописывает решение и поручение,
 * подтверждает протокол — поручения создаются и видны со статусами, — и
 * отправляет протокол участникам на ознакомление. Черновик ИИ проверяется
 * интеграционным тестом с поддельной моделью: на стенде провайдер не настроен.
 */
test.describe('Встречи: протокол', () => {
  test('повестка → решение и поручение → подтверждение → поручения и ознакомление', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

    const users = await request.get(`/api/v1/users?q=${EMPLOYEE_LOGIN}`)
    const employee = ((await users.json()).items as Array<{ id: string; login: string }>).find(
      (user) => user.login === EMPLOYEE_LOGIN,
    )
    expect(employee, 'участник встречи найден').toBeTruthy()

    const created = await request.post('/api/v1/meetings', {
      headers,
      data: { title: `Штаб по паводку ${run}`, participantIds: [employee?.id] },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const meetingId = (await created.json()).id as string

    // Карточка встречи → вкладка «Протокол»: протокола ещё нет
    await page.goto(`/o/${meetingId}`)
    await page.getByRole('tab', { name: 'Протокол' }).click()
    await expect(page.getByText('Протокола ещё нет')).toBeVisible()
    await page.getByRole('button', { name: 'Завести протокол' }).click()
    await expect(page.getByText('Повестка', { exact: true })).toBeVisible()

    // Повестка: вопрос к обсуждению
    await page.getByRole('button', { name: 'Вопрос повестки' }).click()
    const agenda = page.getByRole('article').filter({ hasText: 'Вопрос повестки' })
    await agenda.getByRole('textbox', { name: 'Вопрос повестки' }).fill('Готовность насосов')

    // После встречи: решение и поручение с исполнителем и сроком
    await page.getByRole('button', { name: 'Решение' }).click()
    const decision = page.getByRole('article').filter({ hasText: 'Решение' })
    await decision.getByRole('textbox', { name: 'Решение' }).fill('Обследовать насосы выездом')

    await page.getByRole('button', { name: 'Поручение' }).click()
    const instruction = page.getByRole('article').filter({ hasText: 'Поручение' })
    const title = `Обследовать насосные станции ${run}`
    await instruction.getByRole('textbox', { name: 'Поручение' }).fill(title)
    await instruction.getByRole('combobox', { name: 'Исполнитель' }).click()
    await page.getByRole('option').nth(1).click()
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    await instruction.getByLabel('Срок').fill(due)

    // Подтверждение: блоки-поручения становятся поручениями
    await page.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(page.getByText(/Протокол подтверждён, создано/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Подтверждён', { exact: true })).toBeVisible()
    const instructions = page.getByRole('region', { name: 'Поручения протокола' })
    await expect(instructions.getByText(title)).toBeVisible()
    await expect(instructions.getByText('Назначено')).toBeVisible()

    // Ознакомление участников — механизмом ядра
    await page.getByRole('button', { name: 'Отправить на ознакомление' }).click()
    await expect(page.getByText(/Ознакомление запрошено/)).toBeVisible({ timeout: 20_000 })

    // Регистрация документом: черновик нужного типа открывается вкладкой
    await page.getByRole('button', { name: 'Зарегистрировать документом' }).click()
    const dialog = page.getByRole('dialog', { name: 'Регистрация протокола' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Зарегистрировать документом' }).click()
    await expect(page.getByRole('tab', { name: 'Документ' })).toBeVisible({ timeout: 20_000 })
  })
})
