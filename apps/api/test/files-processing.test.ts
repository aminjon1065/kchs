import { sql } from 'drizzle-orm'
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
 * Превью и текст файлов (P0-E11 S03): задание ставится вместе с версией,
 * движок сообщает результат внутренним маршрутом, просмотрщик получает превью
 * по подписанным ссылкам. Здесь тест играет роль движка.
 */
registerLifecycle()

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

async function jobFor(fileId: string) {
  const rows = await db().execute<{
    id: string
    queue: string
    name: string
    idempotency_key: string
    payload: Record<string, string>
  }>(sql`SELECT id, queue, name, idempotency_key, payload FROM jobs
          WHERE object_id = ${fileId} AND name = 'file.process' ORDER BY created_at DESC`)
  return rows
}

function processed(fileId: string, body: Record<string, unknown>, serviceToken = token) {
  return call(fx.app, {
    method: 'POST',
    url: `/internal/files/${fileId}/processed`,
    payload: body,
    headers: { 'x-kchs-service-token': serviceToken },
  })
}

describe('обработка файлов', () => {
  it('загрузка ставит задание движка в той же транзакции, что и версию', async () => {
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: 'Сводка.pdf',
      content: '%PDF-1.4 test',
      mime: 'application/pdf',
    })
    const jobs = await jobFor(file.id)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.queue).toBe('render')
    const versionId = jobs[0]?.payload.versionId
    expect(jobs[0]?.idempotency_key).toBe(`file.process:${versionId}`)
    expect(jobs[0]?.payload.previewPrefix).toMatch(
      new RegExp(`^spaces/${fx.spaceId}/files/${file.id}/${versionId}/preview/$`),
    )

    const queued = await db().execute(
      sql`SELECT 1 FROM ops.outbox WHERE type = 'job.queued' AND event->'payload'->>'jobId' = ${jobs[0]?.id}`,
    )
    expect(queued.length).toBe(1)
  })

  it('результат движка: превью, текст, статусы и события', async () => {
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: 'Приказ.pdf',
      content: '%PDF-1.4 order',
      mime: 'application/pdf',
    })
    const [job] = await jobFor(file.id)
    const { versionId, previewPrefix } = job?.payload ?? {}

    const unauthorized = await processed(
      file.id,
      { versionId, previewStatus: 'ready', textStatus: 'ready' },
      'неверный-токен',
    )
    expect(unauthorized.statusCode).toBe(401)

    const foreign = await processed(file.id, {
      versionId,
      previewStatus: 'ready',
      textStatus: 'unsupported',
      previews: [{ kind: 'thumbnail', storageKey: 'spaces/other/secret.webp' }],
    })
    expect(foreign.statusCode).toBe(400)

    const ok = await processed(file.id, {
      versionId,
      previewStatus: 'ready',
      textStatus: 'ready',
      pages: 2,
      previews: [
        {
          kind: 'thumbnail',
          storageKey: `${previewPrefix}thumbnail.webp`,
          width: 320,
          height: 450,
        },
        {
          kind: 'page',
          page: 1,
          storageKey: `${previewPrefix}page-1.webp`,
          width: 1240,
          height: 1754,
        },
        {
          kind: 'page',
          page: 2,
          storageKey: `${previewPrefix}page-2.webp`,
          width: 1240,
          height: 1754,
        },
      ],
      text: 'Приказ о мерах по паводку',
      lang: 'ru',
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true, stale: false })

    const previews = await call(fx.app, { url: `/files/${file.id}/previews`, as: fx.users.viewer })
    expect(previews.statusCode).toBe(200)
    const body = previews.json()
    expect(body.previewStatus).toBe('ready')
    expect(body.textStatus).toBe('ready')
    expect(body.pages).toBe(2)
    expect(body.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'page',
      'page',
      'thumbnail',
    ])
    expect(body.items[0].url).toContain('X-Amz-Signature')

    const stranger = await call(fx.app, {
      url: `/files/${file.id}/previews`,
      as: fx.users.stranger,
    })
    expect(stranger.statusCode).toBe(404)

    const text = await db().execute<{ text: string; lang: string }>(
      sql`SELECT text, lang FROM file_texts WHERE file_id = ${file.id}`,
    )
    expect(text[0]).toEqual({ text: 'Приказ о мерах по паводку', lang: 'ru' })

    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE event->'object'->>'id' = ${file.id}
           AND type IN ('file.previewed', 'file.text_extracted')`,
    )
    expect(events.map((e) => e.type).sort()).toEqual(['file.previewed', 'file.text_extracted'])
  })

  it('результат устаревшей версии не принимается, новая версия ставит новое задание', async () => {
    const file = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: 'Отчёт.txt',
      content: 'версия 1',
    })
    const [first] = await jobFor(file.id)

    // Новая версия того же файла
    const session = await call(fx.app, {
      method: 'POST',
      url: '/files/upload-sessions',
      as: fx.admin,
      payload: {
        name: 'Отчёт.txt',
        size: 8,
        mime: 'text/plain',
        spaceId: fx.spaceId,
        fileId: file.id,
      },
    })
    expect(session.statusCode).toBe(200)
    const { uploadId, storageKey, singlePutUrl } = session.json()
    const put = await fetch(singlePutUrl, {
      method: 'PUT',
      body: new TextEncoder().encode('версия 2'),
      headers: { 'content-type': 'text/plain' },
    })
    expect(put.ok).toBe(true)
    const complete = await call(fx.app, {
      method: 'POST',
      url: `/files/upload-sessions/${uploadId}/complete`,
      as: fx.admin,
      payload: { uploadId, storageKey, parts: [] },
    })
    expect(complete.statusCode).toBe(200)

    const jobs = await jobFor(file.id)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]?.payload.versionId).not.toBe(first?.payload.versionId)

    const stale = await processed(file.id, {
      versionId: first?.payload.versionId,
      previewStatus: 'unsupported',
      textStatus: 'ready',
      text: 'версия 1',
    })
    expect(stale.json()).toEqual({ ok: true, stale: true })
    const status = await call(fx.app, { url: `/files/${file.id}/previews`, as: fx.admin })
    expect(status.json().textStatus).toBe('queued')
  })
})
