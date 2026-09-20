import type { APIRequestContext, Page } from '@playwright/test'
import { EMPLOYEE_STATE, expect, test } from './fixtures.js'

/**
 * Медиасервер (профиль `media` в compose) и ключи у api: без них сценарий
 * пропускается — `KCHS_E2E_MEETINGS=1` включает его.
 *
 * Браузеру на хосте нужен медиасервер с достижимым адресом узла: в compose он
 * объявляет адрес контейнера, и на macOS с Docker Desktop поток не доходит
 * (вопрос N23). Для прогона поднимается узел с `node_ip: 127.0.0.1`:
 *
 *   docker run -d --name kchs-livekit-dev -p 7890:7880 -p 50200-50250:50200-50250/udp \
 *     -e LIVEKIT_KEYS="devkey: <секрет>" \
 *     -e LIVEKIT_CONFIG="port: 7880
 *   rtc: {tcp_port: 7882, port_range_start: 50200, port_range_end: 50250, node_ip: 127.0.0.1}" \
 *     livekit/livekit-server:v1.8
 */
const ENABLED = process.env.KCHS_E2E_MEETINGS === '1'

/** Фальшивые камера и микрофон: в headless нет устройств, поток нужен настоящий. */
const MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

/**
 * Комната встречи и звонки (P4-E02 S02–S04, ADR-0091): звонок из API доходит
 * входящим до собеседника, оба входят в комнату медиасервера и видят друг
 * друга, гость по ссылке ждёт в комнате ожидания и входит после разрешения.
 */
test.use({ launchOptions: { args: MEDIA_ARGS }, permissions: ['camera', 'microphone'] })

test.describe('Встречи: комната и звонки', () => {
  test.skip(!ENABLED, 'нужен медиасервер — задайте KCHS_E2E_MEETINGS=1')

  test('входящий звонок, комната на двоих и гость по ссылке', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)

    const status = await (await request.get('/api/v1/meetings/status')).json()
    expect(status.enabled, 'медиасервер настроен').toBeTruthy()

    const colleague = (await (await request.get('/api/v1/users?q=user001')).json()).items[0] as {
      id: string
    }

    // Собеседник ждёт звонка в оболочке: событие приходит ему realtime
    const context = await browser.newContext({
      storageState: EMPLOYEE_STATE,
      permissions: ['camera', 'microphone'],
    })
    const colleaguePage = await context.newPage()
    await colleaguePage.goto('/')
    await expect(colleaguePage.getByRole('tab').first()).toBeVisible({ timeout: 20_000 })

    const csrf = (await (await request.get('/api/v1/me')).json()).session.csrfToken as string
    const call = await request.post('/api/v1/meetings', {
      data: { title: `Звонок e2e ${run}`, participantIds: [colleague.id] },
      headers: { 'x-csrf-token': csrf },
    })
    expect(call.ok(), await call.text()).toBeTruthy()
    const meetingId = (await call.json()).id as string

    // 1. Входящий звонок: собеседник принимает и входит в комнату
    const incoming = colleaguePage.getByTestId('incoming-call')
    await expect(incoming).toBeVisible({ timeout: 20_000 })
    await expect(incoming).toContainText(`Звонок e2e ${run}`)
    await incoming.getByTestId('call-accept').click()
    await colleaguePage.getByTestId('meeting-join').click()
    await expect(colleaguePage.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })

    // 2. Организатор входит из экрана встреч
    await page.goto(`/o/${meetingId}`)
    await page.getByTestId('meeting-join').click()
    await expect(page.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })

    // Оба видят по две плитки: свою и собеседника
    await expect(page.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 })
    await expect(colleaguePage.getByTestId('meeting-tile')).toHaveCount(2, { timeout: 30_000 })

    // Микрофон и камера переключаются, состояние отражено на кнопке
    const mic = page.getByTestId('meeting-mic')
    await expect(mic).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    await mic.click()
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await mic.click()

    // 3. Гость по ссылке: ждёт в комнате ожидания, организатор впускает
    const link = await request.post(`/api/v1/meetings/${meetingId}/guest-link`, {
      data: { ttlMinutes: 60 },
      headers: { 'x-csrf-token': csrf },
    })
    expect(link.ok(), await link.text()).toBeTruthy()
    const url = new URL((await link.json()).url as string)

    const guestContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
    const guestPage = await guestContext.newPage()
    await guestPage.goto(url.pathname)
    await guestPage.getByTestId('guest-name').fill('Гость Сценарий')
    await guestPage.getByTestId('guest-knock').click()
    await expect(guestPage.getByText('Ждём, пока организатор впустит вас')).toBeVisible()

    await page.getByRole('button', { name: 'Участники' }).click()
    const knock = page.getByTestId('meeting-knock')
    await expect(knock).toBeVisible({ timeout: 20_000 })
    await expect(knock).toContainText('Гость Сценарий')
    await knock.getByTestId('meeting-admit').click()

    await expect(guestPage.getByTestId('meeting-room')).toBeVisible({ timeout: 30_000 })
    // Гость видит комнату, но не систему: чата встречи и объектов ему не дают
    await expect(guestPage.getByRole('button', { name: 'Чат встречи' })).toBeHidden()
    await expect(page.getByTestId('meeting-tile')).toHaveCount(3, { timeout: 30_000 })

    // 4. «Показать всем»: объект открывается вкладкой у другого участника
    await showToAll(page, colleaguePage, meetingId, request, csrf)

    await leaveRoom(colleaguePage)
    await leaveRoom(guestPage)
    await leaveRoom(page)
    await guestContext.close()
    await context.close()
  })
})

/** Связанный объект и его показ всем: получатель открывает его своими правами. */
async function showToAll(
  organizer: Page,
  colleague: Page,
  meetingId: string,
  request: APIRequestContext,
  csrf: string,
): Promise<void> {
  const spaces = await (await request.get('/api/v1/spaces')).json()
  const spaceId = (spaces.items as Array<{ id: string }>)[0]?.id as string
  expect(spaceId, 'пространство для связанного объекта').toBeTruthy()
  const folder = await request.post('/api/v1/folders', {
    data: { name: `Показ e2e ${Date.now().toString(36)}`, spaceId },
    headers: { 'x-csrf-token': csrf },
  })
  expect(folder.ok(), await folder.text()).toBeTruthy()
  const objectId = (await folder.json()).id as string
  const linked = await request.post(`/api/v1/objects/${meetingId}/links`, {
    data: { targetId: objectId, kind: 'related' },
    headers: { 'x-csrf-token': csrf },
  })
  expect(linked.ok(), await linked.text()).toBeTruthy()

  await organizer.getByTestId('meeting-show').click()
  const dialog = organizer.getByRole('dialog', { name: 'Показать всем' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /Показ e2e/ }).click()
  await expect(colleague.getByRole('tab', { name: /Показ e2e/ })).toBeVisible({ timeout: 20_000 })
}

async function leaveRoom(page: Page): Promise<void> {
  const leave = page.getByTestId('meeting-leave')
  if (await leave.isVisible().catch(() => false)) await leave.click()
}
