import { eq, inArray } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  uploadFile,
} from './helpers.js'

/**
 * Пространство целиком (ADR-0152): переименование; архив вместе с содержимым по
 * space_id — содержимое только для чтения, возврат снимает ровно то, что ушло с
 * пространством; удалить можно заархивированное или пустое; из корзины оно
 * возвращается с содержимым; общее и системные пространства не трогаются.
 */
registerLifecycle()

const { objects, spaces } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createSpace(key: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/spaces',
    as: fx.admin,
    payload: { key, name: `Проект ${key}`, kind: 'team' },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

async function state(ids: string[]) {
  const rows = await db()
    .select({ id: objects.id, archivedAt: objects.archivedAt, deletedAt: objects.deletedAt })
    .from(objects)
    .where(inArray(objects.id, ids))
  return new Map(rows.map((row) => [row.id, row]))
}

describe('пространство целиком', () => {
  it('переименование и описание', async () => {
    const spaceId = await createSpace(`ren-${run}`)
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/spaces/${spaceId}`,
      as: fx.admin,
      payload: { name: `Паводок-2027 ${run}`, description: 'Штаб весеннего паводка' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const space = (await call(fx.app, { url: `/spaces/${spaceId}`, as: fx.admin })).json()
    expect(space).toMatchObject({
      name: `Паводок-2027 ${run}`,
      description: 'Штаб весеннего паводка',
      archivedAt: null,
    })
    const stranger = await call(fx.app, {
      method: 'PATCH',
      url: `/spaces/${spaceId}`,
      as: fx.users.member,
      payload: { name: 'Чужое' },
    })
    expect([403, 404]).toContain(stranger.statusCode)
  })

  it('архив с содержимым, только чтение, возврат ровно того, что ушло', async () => {
    const spaceId = await createSpace(`arc-${run}`)
    const folderRes = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Сводки', spaceId, parentId: null },
    })
    const folderId = folderRes.json().id as string
    const inside = await uploadFile(fx.app, fx.admin, {
      spaceId,
      folderId,
      name: `сводка ${run}.txt`,
      content: 'цифры',
    })
    const old = await uploadFile(fx.app, fx.admin, {
      spaceId,
      name: `старый ${run}.txt`,
      content: 'давно',
    })
    // Этот файл ушёл в архив раньше пространства — после возврата останется там
    expect(
      (await call(fx.app, { method: 'POST', url: `/objects/${old.id}/archive`, as: fx.admin }))
        .statusCode,
    ).toBe(200)

    const notEmpty = await call(fx.app, {
      method: 'DELETE',
      url: `/spaces/${spaceId}`,
      as: fx.admin,
    })
    expect(notEmpty.statusCode).toBe(400)
    expect(notEmpty.json().errors?.[0]?.code ?? notEmpty.body).toContain('space_not_empty')

    const archived = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${spaceId}/archive`,
      as: fx.admin,
    })
    expect(archived.statusCode, archived.body).toBe(200)
    let rows = await state([spaceId, folderId, inside.id, old.id])
    expect(rows.get(folderId)?.archivedAt).not.toBeNull()
    expect(rows.get(inside.id)?.archivedAt).toBe(rows.get(spaceId)?.archivedAt)
    expect(rows.get(old.id)?.archivedAt).not.toBe(rows.get(spaceId)?.archivedAt)
    expect(
      (await call(fx.app, { url: `/spaces/${spaceId}`, as: fx.admin })).json().archivedAt,
    ).not.toBeNull()

    // Только чтение: ни правки, ни новой папки
    const edit = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${inside.id}`,
      as: fx.admin,
      payload: { title: 'нельзя' },
    })
    expect(edit.statusCode).toBe(403)
    const create = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Новая', spaceId, parentId: null },
    })
    expect(create.statusCode).toBe(403)

    const back = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${spaceId}/unarchive`,
      as: fx.admin,
    })
    expect(back.statusCode, back.body).toBe(200)
    rows = await state([spaceId, folderId, inside.id, old.id])
    expect(rows.get(spaceId)?.archivedAt).toBeNull()
    expect(rows.get(folderId)?.archivedAt).toBeNull()
    expect(rows.get(inside.id)?.archivedAt).toBeNull()
    expect(rows.get(old.id)?.archivedAt).not.toBeNull()
  })

  it('удаление архивного пространства и возврат из корзины с содержимым', async () => {
    const spaceId = await createSpace(`del-${run}`)
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId,
      name: `акт ${run}.txt`,
      content: 'акт',
    })
    await call(fx.app, { method: 'POST', url: `/spaces/${spaceId}/archive`, as: fx.admin })
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/spaces/${spaceId}`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    let rows = await state([spaceId, file.id])
    expect(rows.get(file.id)?.deletedAt).toBe(rows.get(spaceId)?.deletedAt)
    const listed = (await call(fx.app, { url: '/spaces', as: fx.admin })).json().items as Array<{
      id: string
    }>
    expect(listed.map((item) => item.id)).not.toContain(spaceId)

    const restored = await call(fx.app, {
      method: 'POST',
      url: `/objects/${spaceId}/restore`,
      as: fx.admin,
    })
    expect(restored.statusCode, restored.body).toBe(200)
    rows = await state([spaceId, file.id])
    // Пространство возвращается живым: снимаются и корзина, и архив, с которыми оно ушло
    expect(rows.get(file.id)?.deletedAt).toBeNull()
    expect(rows.get(file.id)?.archivedAt).toBeNull()
    expect(rows.get(spaceId)?.archivedAt).toBeNull()
  })

  it('пустое пространство удаляется сразу; общее не архивируется и не удаляется', async () => {
    const spaceId = await createSpace(`emp-${run}`)
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/spaces/${spaceId}`,
      as: fx.admin,
    })
    expect(removed.statusCode, removed.body).toBe(200)

    const [org] = await db().select({ id: spaces.id }).from(spaces).where(eq(spaces.kind, 'org'))
    if (org) {
      const archiveOrg = await call(fx.app, {
        method: 'POST',
        url: `/spaces/${org.id}/archive`,
        as: fx.admin,
      })
      expect(archiveOrg.statusCode).toBe(400)
    }
    // Участник без права управления архивировать не может
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/spaces/${fx.spaceId}/archive`,
      as: fx.users.member,
    })
    expect(denied.statusCode).toBe(403)
  })
})
