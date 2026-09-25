import { eq, sql } from 'drizzle-orm'
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
 * Файлы и папки (ADR-0151): редактор пространства раскладывает файлы по папкам,
 * переименование — это имя файла, откат версии — новая версия с причиной,
 * многочастная загрузка продолжается после обрыва, брошенные сессии закрываются.
 */
registerLifecycle()

const { files, uploadSessions } = await import('../src/shared/db/schema/index.js')
const { FileService } = await import('../src/modules/files/domain/file-service.js')

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

async function folder(name: string, parentId: string | null = null): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId, parentId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

describe('файлы и папки', () => {
  it('редактор переносит файл в папку и переименовывает его; папку в свою ветку — нельзя', async () => {
    const target = await folder(`Приказы ${run}`)
    const file = await uploadFile(fx.app, fx.users.member, {
      spaceId: fx.spaceId,
      name: `черновик ${run}.txt`,
      content: 'текст',
    })

    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${file.id}`,
      as: fx.users.member,
      payload: { parentId: target },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${file.id}`,
      as: fx.users.member,
      payload: { title: `Приказ № 5 ${run}.txt` },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)

    const record = (await call(fx.app, { url: `/files/${file.id}`, as: fx.admin })).json()
    // Папка и имя в таблице модуля — те же, что в реестре: с этим именем файл скачивается
    expect(record.folderId).toBe(target)
    expect(record.name).toBe(`Приказ № 5 ${run}.txt`)

    const child = await folder(`Вложенная ${run}`, target)
    const cycle = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${target}`,
      as: fx.admin,
      payload: { parentId: child },
    })
    expect(cycle.statusCode).toBe(400)

    // Читатель пространства ничего не переносит
    const viewerMove = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${file.id}`,
      as: fx.users.viewer,
      payload: { parentId: null },
    })
    expect(viewerMove.statusCode).toBe(403)
  })

  it('откат версии — новая текущая версия с примечанием и причиной', async () => {
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `отчёт ${run}.txt`,
      content: 'первая редакция',
    })
    const versions = async () =>
      (await call(fx.app, { url: `/files/${file.id}/versions`, as: fx.admin })).json()
        .items as Array<{
        id: string
        number: number
        note: string | null
        size: number
      }>
    const [first] = await versions()
    // Вторая версия поверх
    const second = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: {
        name: `отчёт ${run}.txt`,
        size: 20,
        mime: 'text/plain',
        spaceId: fx.spaceId,
        fileId: file.id,
      },
    })
    const session = second.json()
    await fetch(session.singlePutUrl, {
      method: 'PUT',
      body: new TextEncoder().encode('вторая редакция!!!!'),
      headers: { 'content-type': 'text/plain' },
    })
    const completed = await call(fx.app, {
      method: 'POST',
      url: `/files/upload-sessions/${session.uploadId}/complete`,
      as: fx.admin,
      payload: {
        uploadId: session.uploadId,
        storageKey: session.storageKey,
        parts: [],
        note: 'Поправлены даты',
      },
    })
    expect(completed.statusCode, completed.body).toBe(200)
    expect((await versions())[0]?.note).toBe('Поправлены даты')

    const restored = await call(fx.app, {
      method: 'POST',
      url: `/files/${file.id}/versions/${first?.id}/restore`,
      as: fx.admin,
      payload: { note: 'вторая ушла с ошибкой' },
    })
    expect(restored.statusCode, restored.body).toBe(200)
    const after = await versions()
    expect(after).toHaveLength(3)
    expect(after[0]?.number).toBe(3)
    expect(after[0]?.note).toBe('Восстановлена версия 1: вторая ушла с ошибкой')
    expect(after[0]?.size).toBe(first?.size)
  })

  it('многочастная загрузка продолжается с первой недокачанной части', async () => {
    const size = 17 * 1024 * 1024
    const body = new Uint8Array(size).fill(7)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: {
        name: `большой ${run}.bin`,
        size,
        mime: 'application/octet-stream',
        spaceId: fx.spaceId,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const session = created.json() as {
      uploadId: string
      storageKey: string
      partSize: number
      parts: Array<{ partNumber: number; url: string; size: number }>
    }
    expect(session.parts).toHaveLength(2)
    // Первая часть дошла, вторая — нет: связь оборвалась
    const first = session.parts[0]!
    const put = await fetch(first.url, { method: 'PUT', body: body.slice(0, first.size) })
    expect(put.ok).toBe(true)

    const resumed = await call(fx.app, {
      url: `/files/upload-sessions/${session.uploadId}`,
      as: fx.admin,
    })
    expect(resumed.statusCode, resumed.body).toBe(200)
    const state = resumed.json() as {
      uploaded: Array<{ partNumber: number; etag: string }>
      parts: Array<{ partNumber: number; url: string; size: number }>
    }
    expect(state.uploaded.map((part) => part.partNumber)).toEqual([1])

    const second = state.parts[1]!
    const rest = await fetch(second.url, {
      method: 'PUT',
      body: body.slice(session.partSize, session.partSize + second.size),
    })
    expect(rest.ok).toBe(true)
    const done = await call(fx.app, {
      method: 'POST',
      url: `/files/upload-sessions/${session.uploadId}/complete`,
      as: fx.admin,
      payload: {
        uploadId: session.uploadId,
        storageKey: session.storageKey,
        parts: [
          ...state.uploaded,
          { partNumber: 2, etag: rest.headers.get('etag')?.replace(/"/g, '') ?? '' },
        ],
      },
    })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json().size).toBe(size)

    // Чужую сессию не продолжить; завершённую — тоже
    const stranger = await call(fx.app, {
      url: `/files/upload-sessions/${session.uploadId}`,
      as: fx.users.member,
    })
    expect(stranger.statusCode).toBe(404)
    const closed = await call(fx.app, {
      url: `/files/upload-sessions/${session.uploadId}`,
      as: fx.admin,
    })
    expect(closed.statusCode).toBe(409)
  })

  it('брошенная сессия закрывается обслуживанием', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: {
        name: `брошенный ${run}.bin`,
        size: 9 * 1024 * 1024,
        mime: 'application/octet-stream',
        spaceId: fx.spaceId,
      },
    })
    const { uploadId } = created.json() as { uploadId: string }
    await db()
      .update(uploadSessions)
      .set({ expiresAt: sql`now() - interval '1 hour'` as unknown as string })
      .where(eq(uploadSessions.id, uploadId))
    expect(await FileService.pruneUploadSessions()).toBeGreaterThanOrEqual(1)
    const [row] = await db()
      .select({ status: uploadSessions.status })
      .from(uploadSessions)
      .where(eq(uploadSessions.id, uploadId))
    expect(row?.status).toBe('expired')
    expect(files).toBeDefined()
  })
})
