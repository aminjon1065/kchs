import type { DocumentPhoto } from '@kchs/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/shared/api/errors.js'

/**
 * Донесение без сети (ADR-0212): создание документа со снимками и отправка на регистрацию
 * уходят сразу, а без сети ложатся в очередь устройства и досылаются тем же ключом; отказ
 * по существу — человеку; снимок, уже загруженный прошлым проходом, второй раз не грузится.
 * Отправку на регистрацию настоящим клиентом API проверяет `queue-intake.test.tsx`.
 */
vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
})

const queue = await import('./queue.js')
const photos = await import('./photos.js')
const { PHOTOS_STORE, QUEUE_STORE, readAll } = await import('./store.js')

const TYPE = '00000000-0000-4000-8000-000000000001'
const sent = (id: string) => ({ id, intake: 'sent' as const, error: null })
const problem = (status: number) =>
  new ApiError({
    type: 'about:blank',
    title: 'x',
    status,
    code: status === 403 ? 'forbidden' : 'internal_error',
    detail: 'Недостаточно прав',
  })

let stop: () => void = () => undefined

beforeEach(() => {
  stop = queue.startOfflineQueue('u1')
})

afterEach(async () => {
  for (const entry of await readAll<{ id: string }>(QUEUE_STORE)) {
    await queue.discardOfflineEntry(entry.id)
  }
  queue.setOfflineDocumentSender(null)
  photos.setDocumentPhotoUploader(null)
  stop()
})

const photo = (userId = 'u1') =>
  photos.saveLocalPhoto({ userId, fieldKey: 'report', blob: new Blob(['jpeg']) })

const report = (clientKey: string, ids: string[], userId = 'u1') => ({
  userId,
  title: 'Подмыт мост',
  body: { typeId: TYPE, subject: 'Подмыт мост', fields: {}, clientKey },
  photos: ids,
})

describe('донесение в очереди устройства', () => {
  it('со связью — документ сразу, снимки с устройства стёрты', async () => {
    const shot = await photo()
    queue.setOfflineDocumentSender(async () => sent('d1'))
    const outcome = await queue.submitDocument(report(crypto.randomUUID(), [shot.id]))
    expect(outcome).toEqual({ queued: false, id: 'd1', intake: 'sent', error: null })
    expect(await readAll(QUEUE_STORE)).toHaveLength(0)
    expect(await photos.localPhoto(shot.id, 'u1')).toBeNull()
  })

  it('без сети — в очередь; связь — досылается тем же ключом, оболочка узнаёт документ', async () => {
    const key = crypto.randomUUID()
    const shot = await photo()
    const keys: string[] = []
    let online = false
    queue.setOfflineDocumentSender(async (entry) => {
      keys.push(entry.body.clientKey)
      if (!online) throw new TypeError('Failed to fetch')
      return sent('d2')
    })
    const listener = vi.fn()
    const off = queue.onOfflineDocumentSent(listener)

    expect(await queue.submitDocument(report(key, [shot.id]))).toEqual({ queued: true })
    const [waiting] = await readAll<{ id: string; kind: string; state: string }>(QUEUE_STORE)
    expect(waiting).toMatchObject({ id: key, kind: 'document.create', state: 'pending' })
    // Снимок ждёт вместе с донесением
    expect(await photos.localPhoto(shot.id, 'u1')).not.toBeNull()

    await queue.flushOfflineQueue()
    expect(await readAll(QUEUE_STORE)).toHaveLength(1)

    online = true
    await queue.flushOfflineQueue()
    expect(keys).toEqual([key, key, key])
    expect(await readAll(QUEUE_STORE)).toHaveLength(0)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: key }), sent('d2'))
    expect(await photos.localPhoto(shot.id, 'u1')).toBeNull()
    off()
  })

  it('отказ по существу — запись «не отправлено» с причиной; убрать — стирает и снимки', async () => {
    const shot = await photo()
    let online = false
    queue.setOfflineDocumentSender(async () => {
      if (!online) throw new TypeError('Failed to fetch')
      throw problem(403)
    })
    const key = crypto.randomUUID()
    await queue.submitDocument(report(key, [shot.id]))
    online = true
    await queue.flushOfflineQueue()
    const [failed] = await readAll<{ state: string; error: string | null }>(QUEUE_STORE)
    expect(failed).toMatchObject({ state: 'failed', error: 'Недостаточно прав' })

    await queue.discardOfflineEntry(key)
    expect(await readAll(QUEUE_STORE)).toHaveLength(0)
    expect(await photos.localPhoto(shot.id, 'u1')).toBeNull()
  })

  it('со связью отказ по существу — экрану, не в очередь', async () => {
    queue.setOfflineDocumentSender(async () => {
      throw problem(403)
    })
    await expect(queue.submitDocument(report(crypto.randomUUID(), []))).rejects.toBeInstanceOf(
      ApiError,
    )
    expect(await readAll(QUEUE_STORE)).toHaveLength(0)
  })

  it('снимок, загруженный прошлым проходом, второй раз не грузится', async () => {
    const first = await photo()
    const second = await photo()
    const uploaded: string[] = []
    let fail = true
    photos.setDocumentPhotoUploader(async (_documentId, shot) => {
      if (shot.id === second.id && fail) throw new TypeError('Failed to fetch')
      uploaded.push(shot.id)
      return { id: `file-${shot.id}`, clientKey: shot.id } as unknown as DocumentPhoto
    })
    await expect(
      photos.uploadDocumentPhotos('d3', 'u1', [first.id, second.id]),
    ).rejects.toBeInstanceOf(TypeError)
    fail = false
    await photos.uploadDocumentPhotos('d3', 'u1', [first.id, second.id])
    expect(uploaded).toEqual([first.id, second.id])
    const stored = await readAll<{ id: string; fileId: string | null }>(PHOTOS_STORE)
    expect(stored.find((item) => item.id === first.id)?.fileId).toBe(`file-${first.id}`)
    await photos.forgetPhotos([first.id, second.id])
  })

  it('чужое донесение на общем устройстве не уходит', async () => {
    const sender = vi.fn(async () => sent('d4'))
    queue.setOfflineDocumentSender(async () => {
      throw new TypeError('Failed to fetch')
    })
    await queue.submitDocument(report(crypto.randomUUID(), [], 'u2'))
    queue.setOfflineDocumentSender(sender)
    await queue.flushOfflineQueue()
    expect(sender).not.toHaveBeenCalled()
    expect(await readAll(QUEUE_STORE)).toHaveLength(1)
  })
})
