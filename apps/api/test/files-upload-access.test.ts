import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Проверка в момент действия при загрузке файла (ADR-0123, ADR-0177): возобновляемая
 * сессия живёт долго, и право, отозванное после её открытия, не даёт ни докачать, ни
 * создать файл.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

describe('загрузка файла', () => {
  it('право отозвано между открытием сессии и завершением — файл не создаётся', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка загрузки ${run}`, spaceId: fx.spaceId },
    })
    expect(folder.statusCode, folder.body).toBe(200)
    const folderId = folder.json().id as string
    // Разрыв наследования копирует права явно: участник по-прежнему может загружать
    const restricted = await call(fx.app, {
      method: 'PUT',
      url: `/objects/${folderId}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    expect(restricted.statusCode, restricted.body).toBe(200)

    const content = Buffer.from(`содержимое ${run}`)
    const name = `отчёт-${run}.txt`
    const session = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.users.member,
      payload: {
        name,
        size: content.byteLength,
        mime: 'text/plain',
        spaceId: fx.spaceId,
        folderId,
      },
    })
    expect(session.statusCode, session.body).toBe(200)
    const { uploadId, storageKey, singlePutUrl } = session.json()
    const put = await fetch(singlePutUrl, {
      method: 'PUT',
      body: new Uint8Array(content),
      headers: { 'content-type': 'text/plain' },
    })
    expect(put.ok).toBe(true)

    // Права на папку у участника больше нет
    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${folderId}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.member.id } },
    })
    expect(revoked.statusCode, revoked.body).toBe(200)

    const complete = await call(fx.app, {
      method: 'POST',
      url: `/files/upload-sessions/${uploadId}/complete`,
      as: fx.users.member,
      payload: { uploadId, storageKey, parts: [] },
    })
    expect([403, 404]).toContain(complete.statusCode)

    const listed = await call(fx.app, { url: `/objects?parentId=${folderId}`, as: fx.admin })
    expect(listed.statusCode, listed.body).toBe(200)
    const names = listed.json().items.map((item: { title: string }) => item.title)
    expect(names).not.toContain(name)
  })
})
