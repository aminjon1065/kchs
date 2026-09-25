import { expect, openWorkspace, test } from './fixtures.js'

/** Фальшивые камера и микрофон: в headless нет устройств, поток нужен настоящий. */
const MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

test.use({ launchOptions: { args: MEDIA_ARGS }, permissions: ['camera', 'microphone'] })

/**
 * Проверка перед входом в комнату (ADR-0162): предпросмотр камеры, уровень
 * микрофона и выбор устройств работают в браузере — медиасервер не нужен,
 * достаточно, чтобы встречи были включены (ключи медиасервера заданы).
 */
test('встреча: проверка перед входом — предпросмотр, устройства, выбор запоминается', async ({
  page,
  request,
}) => {
  const status = await (await request.get('/api/v1/meetings/status')).json()
  test.skip(!status.enabled, 'встречи выключены: не заданы ключи медиасервера')

  const run = Date.now().toString(36)
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const created = await request.post('/api/v1/meetings', {
    headers,
    data: { title: `Штаб ${run}`, participantIds: [] },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const meetingId = (await created.json()).id as string

  await openWorkspace(page, request)
  await page.goto(`/o/${meetingId}`)
  await page.getByTestId('meeting-join').click()

  const check = page.getByRole('dialog', { name: 'Проверка перед входом' })
  await expect(check).toBeVisible()
  // Камера по умолчанию включена у звонка и выключена у совещания — проверяем оба положения
  const camera = check.getByRole('switch', { name: 'Войти с камерой' })
  if (await camera.isChecked()) await camera.click()
  await expect(check.getByText('Камера выключена')).toBeVisible()
  await camera.click()
  await expect(check.getByLabel('Предпросмотр камеры')).toBeVisible()
  await expect(check.getByText('Нет доступа к камере или микрофону')).toHaveCount(0)
  await expect(check.getByRole('progressbar', { name: 'Уровень микрофона' })).toBeVisible()

  // Список устройств — от браузера: фальшивая камера видна после разрешения
  await check.getByRole('combobox', { name: 'Камера' }).click()
  const cameras = page.getByRole('option')
  await expect(cameras.nth(1)).toBeVisible()
  const device = ((await cameras.last().textContent()) ?? '').trim()
  await cameras.last().click()
  await expect(check.getByRole('combobox', { name: 'Камера' })).toHaveText(device)

  // Вход без микрофона: выбор уходит в комнату и запоминается для следующего входа
  await check.getByRole('switch', { name: 'Войти с микрофоном' }).click()
  await check.getByRole('button', { name: 'Войти' }).click()
  await expect(check).toBeHidden()
  const saved = await page.evaluate(() => localStorage.getItem('kchs.meetings.devices'))
  expect(JSON.parse(saved ?? '{}')).toMatchObject({ camera: true, mic: false })
  expect(JSON.parse(saved ?? '{}').videoDeviceId).toBeTruthy()

  // Встреча завершается: иначе администратор остался бы «На встрече» для следующих сценариев
  const ended = await request.post(`/api/v1/meetings/${meetingId}/end`, { headers })
  expect(ended.ok(), await ended.text()).toBeTruthy()
})
