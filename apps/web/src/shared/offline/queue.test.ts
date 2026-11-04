import type { FormPhoto, FormSubmission } from '@kchs/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/shared/api/errors.js'

/**
 * Очередь отправок без сети (ADR-0204): IndexedDB в node нет — очередь работает в
 * памяти, логика та же: повтор с тем же ключом, остановка на сетевой ошибке, отказ
 * по существу — человеку, чужие отправки не уходят.
 */
vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
})

const queue = await import('./queue.js')
const photos = await import('./photos.js')
const session = await import('~/shared/api/session.js')

const result = { id: 's1', status: 'submitted' } as unknown as FormSubmission
const problem = (status: number) =>
  new ApiError({
    type: 'about:blank',
    title: 'x',
    status,
    code: status === 409 ? 'conflict' : 'internal_error',
    detail: 'Сводка уже сдана',
  })

let stop: () => void = () => undefined

beforeEach(() => {
  // Сессия есть: токен CSRF досылка берёт из /me (ADR-0228)
  queue.setCsrfRefresher(async () => 'csrf-test')
  stop = queue.startOfflineQueue('u1')
})

afterEach(async () => {
  for (const entry of await snapshot()) await queue.discardOfflineEntry(entry.id)
  queue.setOfflineSender(null)
  queue.setOfflineOpener(null)
  photos.setPhotoUploader(null)
  queue.setCsrfRefresher(null)
  stop()
})

async function snapshot() {
  const { readAll, QUEUE_STORE } = await import('./store.js')
  return readAll<{ id: string; userId: string; state: string; attempts: number }>(QUEUE_STORE)
}

describe('очередь отправок без сети', () => {
  it('сетевая ошибка оставляет сдачу в очереди, связь — досылает тем же ключом', async () => {
    const keys: string[] = []
    let online = false
    queue.setOfflineSender(async (entry) => {
      keys.push(entry.body.clientKey ?? '')
      if (!online) throw new TypeError('Failed to fetch')
      return result
    })
    const sent = vi.fn()
    const off = queue.onOfflineSent(sent)
    const entry = await queue.enqueueFormSubmit({
      userId: 'u1',
      submissionId: 's1',
      formId: 'f1',
      body: { values: { people: 1 } },
    })
    await queue.flushOfflineQueue()
    expect((await snapshot())[0]).toMatchObject({ id: entry.id, state: 'pending', attempts: 1 })
    expect(sent).not.toHaveBeenCalled()

    online = true
    await queue.flushOfflineQueue()
    expect(await snapshot()).toEqual([])
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id }), result)
    // Обе попытки — с одним ключом: повтор безопасен
    expect(new Set(keys)).toEqual(new Set([entry.id]))
    off()
  })

  it('новая правка той же сводки заменяет значения, ключ остаётся прежним', async () => {
    const first = await queue.enqueueFormSubmit({
      userId: 'u1',
      submissionId: 's2',
      formId: 'f1',
      body: { values: { people: 1 }, clientKey: crypto.randomUUID() },
    })
    const second = await queue.enqueueFormSubmit({
      userId: 'u1',
      submissionId: 's2',
      formId: 'f1',
      body: { values: { people: 5 }, clientKey: crypto.randomUUID() },
    })
    expect(second.id).toBe(first.id)
    expect(second.body).toMatchObject({ values: { people: 5 }, clientKey: first.id })
    expect(await snapshot()).toHaveLength(1)
  })

  it('отказ по существу — человеку; шлюз недоступен — повторить позже', async () => {
    expect(queue.isRetryable(problem(503))).toBe(true)
    expect(queue.isRetryable(problem(409))).toBe(false)
    queue.setOfflineSender(async () => {
      throw problem(409)
    })
    await queue.enqueueFormSubmit({
      userId: 'u1',
      submissionId: 's3',
      formId: 'f1',
      body: { values: {} },
    })
    await queue.flushOfflineQueue()
    expect((await snapshot())[0]).toMatchObject({ state: 'failed' })
  })

  it('чужая отправка с общего устройства не уходит от имени вошедшего', async () => {
    const send = vi.fn(async () => result)
    queue.setOfflineSender(send)
    await queue.enqueueFormSubmit({
      userId: 'u2',
      submissionId: 's4',
      formId: 'f1',
      body: { values: {} },
    })
    await queue.flushOfflineQueue()
    expect(send).not.toHaveBeenCalled()
    const { remove, QUEUE_STORE } = await import('./store.js')
    for (const entry of await snapshot()) await remove(QUEUE_STORE, entry.id)
  })

  it('сводка, открытая без сети: открыть на сервере, загрузить снимок, сдать с файлом', async () => {
    const photo = await photos.saveLocalPhoto({
      userId: 'u1',
      fieldKey: 'photo',
      blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    let online = false
    const opened: string[] = []
    const uploads: string[] = []
    const sentBodies: unknown[] = []
    queue.setOfflineOpener(async (entry) => {
      opened.push(entry.submissionId)
      return { ...result, id: 's-remote' }
    })
    photos.setPhotoUploader(async (submissionId, local) => {
      uploads.push(`${submissionId}:${local.id}`)
      if (!online) throw new TypeError('Failed to fetch')
      return { id: 'file-1' } as FormPhoto
    })
    queue.setOfflineSender(async (entry) => {
      sentBodies.push(entry.body)
      return { ...result, id: entry.submissionId }
    })
    const sent = vi.fn()
    const off = queue.onOfflineSent(sent)
    await queue.enqueueFormSubmit({
      userId: 'u1',
      submissionId: `${queue.LOCAL_SUBMISSION}abc`,
      formId: 'f1',
      open: { periodKey: '2026-10-12', subject: { kind: 'unit', id: 'unit-1' } },
      body: { values: { note: 'мост', photo: photo.id } },
    })
    await queue.flushOfflineQueue()
    // Сводка открыта, а снимок не ушёл: в очереди уже серверный ключ сводки
    expect(opened).toEqual([`${queue.LOCAL_SUBMISSION}abc`])
    expect((await snapshot())[0]).toMatchObject({ state: 'pending', attempts: 1 })
    expect(sentBodies).toEqual([])

    online = true
    await queue.flushOfflineQueue()
    expect(opened).toHaveLength(1)
    expect(uploads).toEqual([`s-remote:${photo.id}`, `s-remote:${photo.id}`])
    expect(sentBodies).toEqual([
      expect.objectContaining({ values: { note: 'мост', photo: 'file-1' } }),
    ])
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        localId: `${queue.LOCAL_SUBMISSION}abc`,
        submissionId: 's-remote',
      }),
      expect.objectContaining({ id: 's-remote' }),
    )
    // Дошедший снимок с устройства стёрт
    expect(await photos.localPhoto(photo.id, 'u1')).toBeNull()
    off()
  })

  it('снимок вписывается в 1600 px по длинной стороне и не увеличивается', () => {
    expect(photos.fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(photos.fitWithin(1080, 1920)).toEqual({ width: 900, height: 1600 })
    expect(photos.fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('справочник без сети — из запомненного, ошибка по существу — как есть', async () => {
    const value = await queue.cachedFetch('forms.duties', async () => ({ items: [1] }))
    expect(value).toEqual({ items: [1] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const offline = await queue.cachedFetch('forms.duties', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(offline).toEqual({ items: [1] })
    await expect(
      queue.cachedFetch('forms.duties', async () => {
        throw problem(409)
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('досылка после запуска без сети (ADR-0228)', () => {
  const blank = (submissionId: string) => ({
    userId: 'u1',
    submissionId,
    formId: 'f1',
    body: { values: {} },
  })

  afterEach(() => {
    session.setOnBehalfOf(null)
  })

  it('без токена CSRF сначала перечитывает сессию; нет сессии — запись ждёт', async () => {
    session.setCsrfToken(null)
    const send = vi.fn(async () => result)
    queue.setOfflineSender(send)
    queue.setCsrfRefresher(async () => {
      throw new TypeError('Failed to fetch')
    })
    await queue.enqueueFormSubmit(blank('c1'))
    await queue.flushOfflineQueue()
    expect(send).not.toHaveBeenCalled()
    expect((await snapshot())[0]).toMatchObject({ state: 'pending', attempts: 0 })

    queue.setCsrfRefresher(async () => 'csrf-new')
    await queue.flushOfflineQueue()
    expect(session.getCsrfToken()).toBe('csrf-new')
    expect(send).toHaveBeenCalledOnce()
    expect(await snapshot()).toEqual([])
  })

  it('403 от устаревшего токена — один повтор со свежим; сбой сервера — позже, а не «не сдана»', async () => {
    let calls = 0
    queue.setOfflineSender(async () => {
      calls++
      if (calls === 1) throw problem(403)
      return result
    })
    const refresh = vi.fn(async () => 'csrf-fresh')
    queue.setCsrfRefresher(refresh)
    await queue.enqueueFormSubmit(blank('c2'))
    await queue.flushOfflineQueue()
    expect(calls).toBe(2)
    expect(refresh).toHaveBeenCalled()
    expect(await snapshot()).toEqual([])

    queue.setOfflineSender(async () => {
      throw problem(500)
    })
    await queue.enqueueFormSubmit(blank('c3'))
    await queue.flushOfflineQueue()
    expect((await snapshot())[0]).toMatchObject({ state: 'pending', attempts: 1 })
  })

  it('«Повторить» возвращает отклонённую запись в досылку', async () => {
    queue.setOfflineSender(async () => {
      throw problem(409)
    })
    await queue.enqueueFormSubmit(blank('c4'))
    await queue.flushOfflineQueue()
    const [failed] = await snapshot()
    expect(failed).toMatchObject({ state: 'failed' })

    const send = vi.fn(async () => result)
    queue.setOfflineSender(send)
    await queue.retryOfflineEntry(failed?.id ?? '')
    expect(send).toHaveBeenCalledOnce()
    expect(await snapshot()).toEqual([])
  })

  it('досылка идёт в режиме «от имени», в котором запись создана', async () => {
    const seen: Array<string | null | undefined> = []
    queue.setOfflineSender(async (entry) => {
      seen.push(entry.onBehalfOf)
      throw new TypeError('Failed to fetch')
    })
    session.setOnBehalfOf('boss-1')
    await queue.enqueueFormSubmit(blank('c5'))
    session.setOnBehalfOf(null)
    await queue.flushOfflineQueue()
    expect(seen).toEqual(['boss-1'])
  })
})
