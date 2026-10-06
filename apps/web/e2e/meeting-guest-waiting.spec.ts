import { expect, test } from './fixtures.js'

/**
 * Гость в комнате ожидания (ADR-0193): ведущему, у которого встреча не на экране, приходит
 * сообщение с кнопкой «Открыть встречу»; когда встреча на экране, заявку видно в комнате, и
 * сообщения нет. Медиапоток не нужен — заявка живёт в api, но гостевая ссылка выдаётся только
 * при настроенном медиасервере, без него сценарий пропускается.
 */
test.describe('Комната ожидания', () => {
  test('ведущий вне комнаты узнаёт о госте и открывает встречу', async ({
    page,
    request,
    browser,
  }) => {
    const status = await (await request.get('/api/v1/meetings/status')).json()
    test.skip(!status.enabled, 'гостевая ссылка — только при настроенном медиасервере')
    const run = Date.now().toString(36)
    const title = `Встреча с гостем ${run}`

    // Ведущий — администратор — в оболочке, встреча у него не открыта
    await page.goto('/')
    await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 20_000 })

    const csrf = (await (await request.get('/api/v1/me')).json()).session.csrfToken as string
    const headers = { 'x-csrf-token': csrf }
    const created = await request.post('/api/v1/meetings', { data: { title }, headers })
    expect(created.ok(), await created.text()).toBeTruthy()
    const meetingId = (await created.json()).id as string
    const link = await request.post(`/api/v1/meetings/${meetingId}/guest-link`, {
      data: { ttlMinutes: 60 },
      headers,
    })
    expect(link.ok(), await link.text()).toBeTruthy()
    const url = new URL((await link.json()).url as string)

    const guestContext = await browser.newContext()
    const knockAs = async (name: string) => {
      const guestPage = await guestContext.newPage()
      await guestPage.goto(url.pathname)
      await guestPage.getByTestId('guest-name').fill(name)
      await guestPage.getByTestId('guest-knock').click()
      await expect(guestPage.getByText('Ждём, пока организатор впустит вас')).toBeVisible()
    }

    await knockAs(`Гость ${run}`)
    await expect(page.getByText(`Гость в комнате ожидания: Гость ${run}`)).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'Открыть встречу' }).click()
    await expect(page.getByTestId('meeting-join')).toBeVisible({ timeout: 20_000 })

    // Встреча на экране: второй гость — без сообщения, заявку видно в самой комнате
    await knockAs(`Второй гость ${run}`)
    await page.waitForTimeout(3_000)
    await expect(page.getByText(`Гость в комнате ожидания: Второй гость ${run}`)).toHaveCount(0)
    await guestContext.close()
  })
})
