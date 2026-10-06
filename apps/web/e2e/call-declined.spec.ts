import { EMPLOYEE_STATE, expect, test } from './fixtures.js'

/**
 * Отказ от звонка (ADR-0193): приглашённый отклоняет входящий, звонящий видит, кто отклонил.
 * Медиасервер не нужен — звонок и отказ проходят через api и realtime, комната не открывается.
 */
test.describe('Звонок', () => {
  test('звонящий видит, что приглашённый отклонил звонок', async ({ page, request, browser }) => {
    const run = Date.now().toString(36)

    // Звонящий — администратор — в оболочке: сообщение приходит ему realtime
    await page.goto('/')
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 20_000 })

    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
      displayName: string
    }
    const context = await browser.newContext({ storageState: EMPLOYEE_STATE })
    const colleaguePage = await context.newPage()
    await colleaguePage.goto('/')
    await expect(colleaguePage.getByRole('tab').first()).toBeVisible({ timeout: 20_000 })

    const csrf = (await (await request.get('/api/v1/me')).json()).session.csrfToken as string
    const created = await request.post('/api/v1/meetings', {
      data: { title: `Звонок с отказом ${run}`, participantIds: [colleague.id] },
      headers: { 'x-csrf-token': csrf },
    })
    expect(created.ok(), await created.text()).toBeTruthy()

    const incoming = colleaguePage.getByTestId('incoming-call')
    await expect(incoming).toBeVisible({ timeout: 20_000 })
    await expect(incoming).toContainText(`Звонок с отказом ${run}`)
    await incoming.getByTestId('call-decline').click()
    await expect(incoming).toBeHidden()

    await expect(page.getByText(`Звонок отклонён: ${colleague.displayName}`)).toBeVisible({
      timeout: 20_000,
    })
    // Отклонивший сам себе об отказе не узнаёт
    await expect(colleaguePage.getByText(/Звонок отклонён/)).toHaveCount(0)
    await context.close()
  })
})
