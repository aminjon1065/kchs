import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Вложения (P0-E11 S04, 09-files.md §1): файл, загруженный как вложение, лежит
 * в закрытой системной папке «Вложения» пространства, а доступ к нему выводится
 * из связи `attachment` — кто видит объект, тот видит его вложения.
 */
registerLifecycle()

const { indexObject } = await import('../src/kernel/search/index-service.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createFolder(name: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id as string
}

function attach(hostId: string, name: string, as: TestUser = fx.admin) {
  return uploadFile(fx.app, as, {
    spaceId: fx.spaceId,
    name,
    content: `содержимое ${name}`,
    attachToObjectId: hostId,
  })
}

const status = async (url: string, as: TestUser) => (await call(fx.app, { url, as })).statusCode

async function searchIds(user: TestUser, q: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/search?q=${encodeURIComponent(q)}`, as: user })
  return (response.json().hits as Array<{ objectId: string }>).map((hit) => hit.objectId)
}

describe('вложения: размещение', () => {
  it('файл ложится в системную папку «Вложения», корень пространства её не показывает', async () => {
    const host = await createFolder(`Донесение ${run}`)
    const file = await attach(host, `Схема района ${run}.txt`)

    const record = (await call(fx.app, { url: `/objects/${file.id}`, as: fx.admin })).json()
    const folder = await call(fx.app, {
      url: `/files/attachments-folder?spaceId=${fx.spaceId}`,
      as: fx.users.viewer,
    })
    expect(folder.json().id).toBe(record.parentId)

    const root = await call(fx.app, {
      url: `/objects?spaceId=${fx.spaceId}&parentId=root&types=folder,file&limit=200`,
      as: fx.admin,
    })
    const ids = root.json().items.map((item: { id: string }) => item.id)
    expect(ids).not.toContain(record.parentId)
    expect(ids).not.toContain(file.id)

    const links = await call(fx.app, { url: `/objects/${host}/links`, as: fx.admin })
    expect(
      links
        .json()
        .links.some(
          (link: { kind: string; object: { id: string } }) =>
            link.kind === 'attachment' && link.object.id === file.id,
        ),
    ).toBe(true)
  })

  it('вложение грузится в пространство объекта и требует права edit на объект', async () => {
    const host = await createFolder(`Проверка прав ${run}`)
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.users.viewer,
      payload: {
        name: 'нет.txt',
        size: 1,
        mime: 'text/plain',
        spaceId: fx.spaceId,
        attachToObjectId: host,
      },
    })
    expect(denied.statusCode).toBe(403)

    const mismatch = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: {
        name: 'чужое.txt',
        size: 1,
        mime: 'text/plain',
        spaceId: fx.orgSpaceId,
        attachToObjectId: host,
      },
    })
    expect(mismatch.statusCode).toBe(400)
  })

  it('права на объект достаточно: посторонний с edit на объекте прикрепляет файл', async () => {
    const host = await createFolder(`Для постороннего ${run}`)
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${host}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'edit' }],
      },
    })
    const file = await attach(host, `От постороннего ${run}.txt`, fx.users.stranger)
    expect(await status(`/objects/${file.id}`, fx.users.stranger)).toBe(200)
  })
})

describe('вложения: доступ через объект', () => {
  it('читатель объекта видит вложение, редактор правит, делиться может только владелец', async () => {
    const host = await createFolder(`Акт обследования ${run}`)
    const file = await attach(host, `Фото моста ${run}.txt`)

    const viewer = await call(fx.app, { url: `/objects/${file.id}`, as: fx.users.viewer })
    expect(viewer.statusCode).toBe(200)
    expect(viewer.json().level).toBe('view')

    const member = await call(fx.app, { url: `/objects/${file.id}`, as: fx.users.member })
    expect(member.json().level).toBe('edit')
    const explain = await call(fx.app, { url: `/objects/${file.id}/access`, as: fx.admin })
    expect(explain.statusCode).toBe(200)

    const share = await call(fx.app, {
      method: 'POST',
      url: `/objects/${file.id}/access`,
      as: fx.users.member,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
      },
    })
    expect(share.statusCode).toBe(403)
    expect(await status(`/objects/${file.id}`, fx.users.stranger)).toBe(404)
  })

  it('вложение закрытого объекта не видно участникам пространства без доступа к объекту', async () => {
    const host = await createFolder(`Закрытое донесение ${run}`)
    await call(fx.app, {
      method: 'PUT',
      url: `/objects/${host}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${host}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.viewer.id } },
    })
    const file = await attach(host, `Секретная схема ${run}.txt`)

    expect(await status(`/objects/${host}`, fx.users.viewer)).toBe(404)
    expect(await status(`/objects/${file.id}`, fx.users.viewer)).toBe(404)
    expect(await status(`/objects/${file.id}`, fx.users.member)).toBe(200)
  })

  it('открепление снимает доступ, поиск следует за ним', async () => {
    const host = await createFolder(`Сводка с вложением ${run}`)
    const name = `Карта подтопления ${run}.txt`
    const file = await attach(host, name)

    await indexObject(file.id)
    const deadline = Date.now() + 10_000
    let hits: string[] = []
    while (Date.now() < deadline) {
      hits = await searchIds(fx.users.viewer, name)
      if (hits.includes(file.id)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(hits).toContain(file.id)

    const detached = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${host}/links/${file.id}/attachment`,
      as: fx.users.member,
    })
    expect(detached.statusCode).toBe(200)
    expect(await status(`/objects/${file.id}`, fx.users.viewer)).toBe(404)

    await indexObject(file.id)
    const until = Date.now() + 10_000
    while (Date.now() < until && (await searchIds(fx.users.viewer, name)).includes(file.id)) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(await searchIds(fx.users.viewer, name)).not.toContain(file.id)
  })

  it('прикрепить существующий файл может только тот, кто вправе им делиться', async () => {
    const host = await createFolder(`Приёмник ${run}`)
    const source = await createFolder(`Источник ${run}`)
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      folderId: source,
      name: `Общий файл ${run}.txt`,
      content: 'x',
    })
    const byEditor = await call(fx.app, {
      method: 'POST',
      url: `/objects/${host}/links`,
      as: fx.users.member,
      payload: { targetId: file.id, kind: 'attachment' },
    })
    expect(byEditor.statusCode).toBe(403)

    const byOwner = await call(fx.app, {
      method: 'POST',
      url: `/objects/${host}/links`,
      as: fx.admin,
      payload: { targetId: file.id, kind: 'attachment' },
    })
    expect(byOwner.statusCode).toBe(200)
  })

  it('гость по ссылке видит вложения, только если ссылка их включает', async () => {
    const host = await createFolder(`Для гостя ${run}`)
    const file = await attach(host, `Гостевое вложение ${run}.txt`)
    const open = async (includeAttachments: boolean) => {
      const link = await call(fx.app, {
        method: 'POST',
        url: `/objects/${host}/share-links`,
        as: fx.admin,
        payload: { level: 'view', includeAttachments },
      })
      const opened = await call(fx.app, {
        method: 'POST',
        url: `/share/${link.json().token}/open`,
        payload: {},
      })
      return { 'x-kchs-share-token': opened.json().accessToken as string }
    }
    const withAttachments = await open(true)
    const withoutAttachments = await open(false)
    expect(
      (await call(fx.app, { url: `/objects/${file.id}`, headers: withAttachments })).statusCode,
    ).toBe(200)
    expect(
      (await call(fx.app, { url: `/objects/${file.id}`, headers: withoutAttachments })).statusCode,
    ).toBe(404)
  })
})
