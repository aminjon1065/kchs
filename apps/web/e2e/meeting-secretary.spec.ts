import { EMPLOYEE_STATE, expect, test } from './fixtures.js'

const EMPLOYEE_LOGIN = 'user001'
const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const READER_HINT =
  'Протокол правят организатор и секретарь, остальные участники читают и обсуждают'

/**
 * Секретарь встречи (N30, ADR-0137): протокол правят организатор и назначенный им
 * секретарь, остальные участники читают и обсуждают. Организатор назначает
 * секретаря в карточке встречи и снимает его — у участника правка закрывается.
 */
test.describe('Встречи: секретарь ведёт протокол', () => {
  test('организатор назначает секретаря — тот правит протокол; снятый только читает', async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const users = await request.get(`/api/v1/users?q=${EMPLOYEE_LOGIN}`)
    const employee = (
      (await users.json()).items as Array<{ id: string; login: string; displayName: string }>
    ).find((user) => user.login === EMPLOYEE_LOGIN)
    expect(employee, 'участник встречи найден').toBeTruthy()
    const name = employee?.displayName as string

    const created = await request.post('/api/v1/meetings', {
      headers,
      data: { title: `Заседание штаба ${run}`, participantIds: [employee?.id] },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const meetingId = (await created.json()).id as string

    // Организатор: назначить участника секретарём в списке «Приглашены»
    await page.goto(`/o/${meetingId}`)
    await page.getByRole('button', { name: `Назначить секретарём: ${name}` }).click()
    await expect(
      page.getByText('Секретарь назначен — он ведёт протокол вместе с вами'),
    ).toBeVisible()
    await expect(page.getByText('Секретарь', { exact: true }).first()).toBeVisible()

    // Секретарь: протокол заведён назначением и открыт для правки
    const context = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    const secretary = await context.newPage()
    try {
      await secretary.goto(`/o/${meetingId}`)
      await secretary.getByRole('tab', { name: 'Протокол' }).click()
      await expect(secretary.getByRole('button', { name: 'Вопрос повестки' })).toBeVisible({
        timeout: 20_000,
      })
      await expect(secretary.getByText(READER_HINT)).toHaveCount(0)

      // Секретаря сняли — у участника только чтение и пояснение почему
      await page.getByRole('button', { name: `Снять секретаря: ${name}` }).click()
      await expect(page.getByText('Секретарь снят')).toBeVisible()
      await secretary.reload()
      await secretary.getByRole('tab', { name: 'Протокол' }).click()
      await expect(secretary.getByText(READER_HINT)).toBeVisible({ timeout: 20_000 })
      await expect(secretary.getByRole('button', { name: 'Вопрос повестки' })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
