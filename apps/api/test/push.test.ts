import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Push-уведомления (P4-E02 S08, ADR-0094): устройство подписывается ключом
 * VAPID установки, канал ядра доставляет уведомление в службу браузера,
 * снятая службой подписка удаляется. Без ключей функция выключена.
 */
registerLifecycle()

const { PushService, pushConfig } = await import('../src/modules/push/domain/push-service.js')
const { resetConfigCache } = await import('../src/shared/config/index.js')

const run = Date.now().toString(36)
// Пара VAPID для тестов (сгенерирована openssl, к установке отношения не имеет)
const KEYS = {
  PUSH_VAPID_PUBLIC_KEY:
    'BGby8xy3hK-B_X3xqErO5Yswwog7-50p-IbpuZSSf-hGNkMdAM40EywPMh2_VXOTLued41B1g6WCz_VQJCxQqak',
  PUSH_VAPID_PRIVATE_KEY: 'E_u0fsICrFZfm6jfnNu66XIFvosv1WrL6kmBGTOgUuk',
  PUSH_CONTACT: 'mailto:admin@example.org',
}

let fx: TestContext
let user: TestUser
let other: TestUser
let service: Server
let endpointBase = ''
let certDir = ''
let tlsStrict: string | undefined
const delivered: Array<{ path: string; length: number }> = []
let gone = false

/** Самоподписанный сертификат: службы доставки работают только по HTTPS. */
function selfSigned(): { key: Buffer; cert: Buffer } {
  certDir = mkdtempSync(path.join(tmpdir(), 'kchs-push-'))
  const key = path.join(certDir, 'key.pem')
  const cert = path.join(certDir, 'cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ])
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

function withPush(on: boolean): void {
  for (const [key, value] of Object.entries(KEYS)) {
    if (on) process.env[key] = value
    else delete process.env[key]
  }
  resetConfigCache()
}

beforeAll(async () => {
  fx = await setupFixture()
  user = await createUser(fx.app, `push_user_${run}`, ['employee'])
  other = await createUser(fx.app, `push_other_${run}`, ['employee'])
  // Поддельная служба доставки браузера: принимает зашифрованное сообщение.
  // Сертификат самоподписанный — на время файла проверка TLS выключается
  tlsStrict = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  service = createServer(selfSigned(), (request, response) => {
    let length = 0
    request.on('data', (chunk: Buffer) => {
      length += chunk.length
    })
    request.on('end', () => {
      delivered.push({ path: request.url ?? '', length })
      response.writeHead(gone ? 410 : 201).end()
    })
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  endpointBase = `https://127.0.0.1:${(service.address() as AddressInfo).port}/push`
})

afterAll(async () => {
  withPush(false)
  await new Promise((resolve) => service?.close(resolve))
  if (tlsStrict === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsStrict
  if (certDir) rmSync(certDir, { recursive: true, force: true })
})

const device = (suffix: string) => ({
  endpoint: `${endpointBase}/${suffix}`,
  keys: {
    // Ключи устройства: открытый ключ P-256 и секрет аутентификации
    p256dh:
      'BMRBc0ckTYI8xJB8_IujjI2QsfxJj6Xfqf0CWQVLjCN3-uP4-FG-ZyKcQTe8r5g5-LfrAmxY0EFh-VG57Uuy8os',
    auth: 'NfN_wOvge96-B741Pf3RVA',
  },
  userAgent: 'Chrome для тестов',
})

describe('push выключен', () => {
  it('статус сообщает, подписка отклоняется', async () => {
    withPush(false)
    const status = await call(fx.app, { url: '/me/push', as: user })
    expect(status.statusCode, status.body).toBe(200)
    expect(status.json()).toEqual({ enabled: false, publicKey: null, devices: 0 })
    const subscribed = await call(fx.app, {
      method: 'POST',
      url: '/me/push/subscriptions',
      as: user,
      payload: device('off'),
    })
    expect(subscribed.statusCode).toBe(503)
  })
})

describe('подписка устройства и доставка', () => {
  it('ключ VAPID отдаётся браузеру, устройство считается у владельца', async () => {
    withPush(true)
    expect(pushConfig()?.publicKey).toBe(KEYS.PUSH_VAPID_PUBLIC_KEY)
    const status = await call(fx.app, { url: '/me/push', as: user })
    expect(status.json()).toMatchObject({
      enabled: true,
      publicKey: KEYS.PUSH_VAPID_PUBLIC_KEY,
      devices: 0,
    })

    const subscribed = await call(fx.app, {
      method: 'POST',
      url: '/me/push/subscriptions',
      as: user,
      payload: device('one'),
    })
    expect(subscribed.statusCode, subscribed.body).toBe(200)
    // Повторная подписка того же устройства не плодит записей
    await call(fx.app, {
      method: 'POST',
      url: '/me/push/subscriptions',
      as: user,
      payload: device('one'),
    })
    const mine = await call(fx.app, { url: '/me/push', as: user })
    expect(mine.json().devices).toBe(1)
    const stranger = await call(fx.app, { url: '/me/push', as: other })
    expect(stranger.json().devices).toBe(0)
  })

  it('канал доступен подписавшимся и шифрует сообщение в службу доставки', async () => {
    withPush(true)
    const available = await PushService.subscribed([user.id, other.id])
    expect([...available]).toEqual([user.id])

    delivered.length = 0
    await PushService.deliver([
      {
        notificationId: 1,
        userId: user.id,
        locale: 'ru',
        category: 'chat.direct',
        text: 'Новое сообщение в беседе',
        url: 'http://localhost:5173/o/00000000-0000-0000-0000-000000000000',
      },
    ])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.path).toBe('/push/one')
    // Тело зашифровано ключами устройства — сервер отдал непустой блок
    expect(delivered[0]?.length).toBeGreaterThan(0)
  })

  it('служба доставки сняла подписку — устройство удаляется', async () => {
    withPush(true)
    gone = true
    await PushService.deliver([
      {
        notificationId: 2,
        userId: user.id,
        locale: 'ru',
        category: 'chat.direct',
        text: 'Сообщение в закрытый браузер',
        url: 'http://localhost:5173/',
      },
    ])
    gone = false
    const status = await call(fx.app, { url: '/me/push', as: user })
    expect(status.json().devices).toBe(0)
  })

  it('отписка устройства снимает подписку', async () => {
    withPush(true)
    await call(fx.app, {
      method: 'POST',
      url: '/me/push/subscriptions',
      as: user,
      payload: device('two'),
    })
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: '/me/push/subscriptions',
      as: user,
      payload: { endpoint: `${endpointBase}/two` },
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json()).toEqual({ ok: true })
    expect((await call(fx.app, { url: '/me/push', as: user })).json().devices).toBe(0)
    // Чужое устройство снять нельзя
    await call(fx.app, {
      method: 'POST',
      url: '/me/push/subscriptions',
      as: user,
      payload: device('three'),
    })
    const foreign = await call(fx.app, {
      method: 'DELETE',
      url: '/me/push/subscriptions',
      as: other,
      payload: { endpoint: `${endpointBase}/three` },
    })
    expect(foreign.json()).toEqual({ ok: false })
  })
})
