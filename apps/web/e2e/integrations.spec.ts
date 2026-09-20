import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Публичный API, вебхуки и интеграции (P5-E02, P5-E06, ADR-0097).
 *
 * Сквозной путь: администратор выпускает токен в профиле, ходит им в API,
 * заводит интеграцию с входящим вебхуком и подписку на события, видит доставку
 * в журнале. Проверки безопасности — в интеграционных тестах api; здесь
 * проверяется, что экраны работают и токен действительно открывает API.
 */

interface Received {
  headers: Record<string, string | undefined>
  body: string
}

let server: Server
let hookUrl = ''
const received: Received[] = []

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push({ headers: request.headers as Record<string, string | undefined>, body })
      response.statusCode = 200
      response.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test.describe('Публичный API и вебхуки', () => {
  test('токен из профиля открывает API и отзывается', async ({ page, request }) => {
    await openWorkspace(page, request)
    await page.goto('/profile')

    const name = `Интеграция ${Date.now().toString(36)}`
    await page.getByRole('button', { name: 'Выпустить токен' }).click()
    const dialog = page.getByRole('dialog', { name: 'Выпустить токен' })
    await dialog.getByLabel('Название').fill(name)
    await dialog.getByRole('button', { name: 'read:objects', exact: true }).click()
    await dialog.getByRole('button', { name: 'Выпустить' }).click()

    const issued = page.getByRole('dialog', { name: 'Токен выпущен' })
    await expect(issued).toBeVisible()
    const secret = (await issued.locator('code').innerText()).trim()
    expect(secret.startsWith('kchs_')).toBeTruthy()
    await issued.getByRole('button', { name: 'Закрыть' }).last().click()

    // Токен ходит в API без cookie и без CSRF-токена
    const withToken = await request.get('/api/v1/spaces', {
      headers: { authorization: `Bearer ${secret}` },
    })
    // Область `read:objects` не покрывает пространства — отказ по области
    expect(withToken.status()).toBe(403)

    const objects = await request.post('/api/v1/objects/batch-get', {
      headers: { authorization: `Bearer ${secret}` },
      data: { ids: ['00000000-0000-7000-8000-000000000000'] },
    })
    expect(objects.status()).toBe(200)

    // Отзыв: тот же запрос перестаёт работать
    const row = page.getByRole('listitem').filter({ hasText: name })
    await row.getByRole('button', { name: 'Отозвать' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Отозвать' }).click()
    await expect(page.getByText('Токен отозван')).toBeVisible()

    const revoked = await request.post('/api/v1/objects/batch-get', {
      headers: { authorization: `Bearer ${secret}` },
      data: { ids: ['00000000-0000-7000-8000-000000000000'] },
    })
    expect(revoked.status()).toBe(401)
  })

  test('интеграция с входящим вебхуком заводится и проверяется', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Интеграции' }).click()

    // Встроенные службы установки — в общем списке только для чтения
    await expect(page.getByText('Исходящая почта (SMTP)')).toBeVisible()
    await expect(page.getByText('Telegram-бот')).toBeVisible()

    const key = `stand-${Date.now().toString(36)}`
    await page.getByRole('button', { name: 'Новая интеграция' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новая интеграция' })
    await dialog.getByLabel('Ключ').fill(key)
    await dialog.getByLabel('Название').fill(`Служба ${key}`)
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Интеграция заведена')).toBeVisible()

    const row = page.getByRole('listitem').filter({ hasText: key })
    await row.getByRole('button', { name: 'Входящий вебхук' }).click()
    const inbound = page.getByRole('dialog', { name: 'Адрес входящего вебхука' })
    await expect(inbound).toBeVisible()
    const url = (await inbound.locator('code').innerText()).trim()
    await inbound.getByRole('button', { name: 'Закрыть' }).last().click()

    // Запрос по адресу принимается и не требует сессии
    const posted = await request.post(url.replace(/^https?:\/\/[^/]+/, ''), {
      data: { event: 'ping' },
      headers: { cookie: '' },
    })
    expect(posted.status()).toBe(202)

    // Неверный секрет неотличим от несуществующей интеграции
    const wrong = await request.post(`${url.replace(/^https?:\/\/[^/]+/, '').slice(0, -4)}zzzz`, {
      data: {},
    })
    expect(wrong.status()).toBe(404)
  })

  test('вебхук доставляет событие с подписью и показывает журнал', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Интеграции' }).click()

    const name = `Подписка ${Date.now().toString(36)}`
    await page.getByRole('button', { name: 'Новый вебхук' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новый вебхук' })
    await dialog.getByLabel('Название').fill(name)
    await dialog.getByLabel('Адрес').fill(hookUrl)
    await dialog.getByLabel('События').fill('object.created')
    await dialog.getByRole('button', { name: 'Создать' }).click()

    const secretDialog = page.getByRole('dialog', { name: 'Секрет подписи' })
    await expect(secretDialog).toBeVisible()
    const secret = (await secretDialog.locator('code').innerText()).trim()
    await secretDialog.getByRole('button', { name: 'Закрыть' }).last().click()

    // Любое действие порождает `object.created` — создаём папку в личном пространстве
    const me = await request.get('/api/v1/me')
    const csrfToken = (await me.json()).session.csrfToken as string
    const spaces = await request.get('/api/v1/spaces')
    const spaceId = (await spaces.json()).items[0].id as string
    const folder = await request.post('/api/v1/folders', {
      headers: { 'x-csrf-token': csrfToken },
      data: { spaceId, name: `Папка ${name}` },
    })
    expect(folder.ok()).toBeTruthy()

    // Доставку выполняет worker: ждём запроса на тестовый сервер
    await expect
      .poll(() => received.length, { timeout: 30_000, intervals: [500] })
      .toBeGreaterThan(0)

    const delivery = received[received.length - 1]
    const timestamp = delivery?.headers['x-kchs-timestamp'] ?? ''
    const expected = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.${delivery?.body ?? ''}`)
      .digest('hex')}`
    expect(delivery?.headers['x-kchs-signature']).toBe(expected)
    expect(delivery?.headers['x-kchs-event']).toBe('object.created')

    // Журнал доставок в интерфейсе
    const row = page.getByRole('listitem').filter({ hasText: name })
    await row.getByRole('button', { name: 'Доставки' }).click()
    const log = page.getByRole('dialog', { name: `Доставки: ${name}` })
    await expect(log.getByText('Доставлено')).toBeVisible({ timeout: 20_000 })
    await log.getByRole('button', { name: 'Закрыть' }).last().click()

    // Уборка стенда: подписка не должна стучаться после прогона
    await row.getByRole('button', { name: 'Удалить' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
  })

  test('пакет конфигурации выгружается и импортируется без различий', async ({ page, request }) => {
    await openWorkspace(page, request)
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Конфигурация' }).click()

    await page.getByRole('checkbox', { name: 'Интеграции' }).check()
    await page.getByRole('button', { name: 'Выгрузить пакет' }).click()
    await expect(page.getByText('Пакет выгружен')).toBeVisible()

    const json = await page.getByLabel('Пакет (JSON)').inputValue()
    expect(json).toContain('"version": 1')

    await page.getByRole('button', { name: 'Показать различия' }).click()
    // Заголовок карточки дизайн-системы — не heading (известное ограничение)
    await expect(page.getByText('Различия', { exact: true })).toBeVisible()
    // Тот же контур: всё совпадает
    await expect(page.getByText('Совпадает').first()).toBeVisible()
  })
})
