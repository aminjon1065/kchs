import { onlineManager, QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { saveLocalPhoto } from '~/shared/offline/photos.js'
import { formPhotoQuery } from './queries.js'

/**
 * Сводка без сети (ADR-0204, ADR-0208). После события `offline` браузера TanStack Query
 * ставит запросы на паузу, не вызывая функцию: миниатюра снимка, который лежит на
 * устройстве, показывала «Фото недоступно» до появления связи.
 */
afterEach(() => onlineManager.setOnline(true))

/** Ответ запроса или отметка, что он так и не начался за полсекунды. */
async function settle<T>(promise: Promise<T>): Promise<T | 'paused'> {
  return Promise.race([
    promise,
    new Promise<'paused'>((resolve) => setTimeout(() => resolve('paused'), 500)),
  ])
}

describe('formPhotoQuery', () => {
  it('без сети отдаёт снимок с устройства, а не ждёт связи', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const photo = await saveLocalPhoto({ userId: 'u1', fieldKey: 'photo', blob })
    onlineManager.setOnline(false)
    const client = new QueryClient()
    const result = await settle(client.fetchQuery(formPhotoQuery(photo.id, 'u1')))
    expect(result).toMatchObject({ kind: 'local' })
  })

  it('чужой снимок с устройства не отдаёт', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const photo = await saveLocalPhoto({ userId: 'u1', fieldKey: 'photo', blob })
    onlineManager.setOnline(false)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await expect(client.fetchQuery(formPhotoQuery(photo.id, 'u2'))).rejects.toBeTruthy()
  })
})
