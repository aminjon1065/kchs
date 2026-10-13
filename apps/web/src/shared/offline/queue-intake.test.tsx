import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as queue from './queue.js'
import { QUEUE_STORE, readAll } from './store.js'

/**
 * Донесение — на регистрацию (ADR-0212) настоящим клиентом API: после создания и снимков
 * очередь шлёт `POST /documents/{id}/intake`; отказ регистрации по существу оставляет
 * донесение черновиком автора, а не «не отправлено»; без сети — запись ждёт и досылается
 * целиком. Окружение — happy-dom: клиенту API нужен `document`.
 */
let stop: () => void = () => undefined

beforeEach(() => {
  stop = queue.startOfflineQueue('u1')
})

afterEach(async () => {
  for (const entry of await readAll<{ id: string }>(QUEUE_STORE)) {
    await queue.discardOfflineEntry(entry.id)
  }
  stop()
})

const report = (clientKey: string) => ({
  userId: 'u1',
  title: 'Подмыт мост',
  body: {
    typeId: '00000000-0000-4000-8000-000000000001',
    subject: 'Подмыт мост',
    fields: {},
    clientKey,
  },
  photos: [],
})

describe('донесение — на регистрацию', () => {
  const DOC = '00000000-0000-4000-8000-0000000000d5'
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': status === 200 ? 'application/json' : 'application/problem+json' },
    })

  function stubApi(intake: () => Response) {
    const calls: string[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, '')
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/documents') return reply({ id: DOC })
      if (path === `/documents/${DOC}/intake`) return intake()
      return reply({ type: 'about:blank', title: 'Нет', status: 404, code: 'not_found' }, 404)
    })
    return { calls, restore: () => spy.mockRestore() }
  }

  it('после создания — на регистрацию тем же запросом очереди; ответ — в результате', async () => {
    const api = stubApi(() => reply({ state: 'sent', instanceId: null }))
    try {
      const outcome = await queue.submitDocument(report(crypto.randomUUID()))
      expect(outcome).toEqual({ queued: false, id: DOC, intake: 'sent', error: null })
      expect(api.calls).toEqual(['POST /documents', `POST /documents/${DOC}/intake`])
    } finally {
      api.restore()
    }
  })

  it('регистрация отказала по существу — донесение остаётся черновиком, не «не отправлено»', async () => {
    const api = stubApi(() =>
      reply(
        {
          type: 'about:blank',
          title: 'Проверьте назначенных',
          status: 400,
          code: 'validation_failed',
          detail: 'Не удалось определить назначенных шага «Регистрация донесения»',
        },
        400,
      ),
    )
    try {
      const outcome = await queue.submitDocument(report(crypto.randomUUID()))
      expect(outcome).toMatchObject({ queued: false, id: DOC, intake: 'failed' })
      expect(await readAll(QUEUE_STORE)).toHaveLength(0)
    } finally {
      api.restore()
    }
  })

  it('регистрация без сети — донесение ждёт в очереди и досылается целиком', async () => {
    let online = false
    const api = stubApi(() => {
      if (!online) throw new TypeError('Failed to fetch')
      return reply({ state: 'sent', instanceId: null })
    })
    try {
      expect(await queue.submitDocument(report(crypto.randomUUID()))).toEqual({
        queued: true,
      })
      online = true
      await queue.flushOfflineQueue()
      expect(await readAll(QUEUE_STORE)).toHaveLength(0)
      // Создание повторено тем же ключом, регистрация — дошла со второго прохода
      expect(api.calls.filter((call) => call.endsWith('/intake'))).toHaveLength(2)
    } finally {
      api.restore()
    }
  })
})
