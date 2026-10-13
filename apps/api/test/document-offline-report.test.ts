import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Донесение без сети (ADR-0212): создание документа с ключом устройства повторяемо —
 * повтор и гонка двух одновременных запросов дают один документ, одно событие и одну
 * запись аудита; ключ — по автору. Фото черновика — JPEG без метаданных, файл реестра,
 * прикреплённый к документу; повтор с тем же ключом снимка — тот же файл.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { documents, links } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
let fx: TestContext
const types = new Map<string, string>()

const segment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.byteLength + 2, 2)
  return Buffer.concat([head, data])
}

/** JPEG по структуре, с EXIF и координатами съёмки — их сервер обязан выбросить. */
function photo(label: string): string {
  const frame = Buffer.alloc(6)
  frame[0] = 8
  frame.writeUInt16BE(900, 1)
  frame.writeUInt16BE(1600, 3)
  frame[5] = 1
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1')),
    segment(0xe1, Buffer.from('Exif\0\0GPSLatitude 38.5598', 'latin1')),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc0, frame),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from(label, 'utf8'),
    Buffer.from([0xff, 0xd9]),
  ]).toString('base64')
}

const create = (payload: Record<string, unknown>, as = fx.users.member) =>
  call(fx.app, { method: 'POST', url: '/documents', as, payload })

async function createdEvents(id: string): Promise<number> {
  const rows = await db().execute<{ total: number }>(
    sql`SELECT count(*)::int AS total FROM ops.outbox
         WHERE event->>'type' = 'document.created' AND event->'object'->>'id' = ${id}`,
  )
  return rows[0]?.total ?? 0
}

beforeAll(async () => {
  fx = await setupFixture()
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
})

describe('создание документа с ключом устройства', () => {
  it('повтор с тем же ключом — тот же документ, одно событие', async () => {
    const clientKey = randomUUID()
    const payload = { typeId: types.get('memo'), subject: `Донесение ${run}`, clientKey }
    const first = await create(payload)
    expect(first.statusCode, first.body).toBe(200)
    const again = await create(payload)
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json().id).toBe(first.json().id)
    expect(await createdEvents(first.json().id)).toBe(1)

    // Без ключа — как раньше: каждый запрос создаёт новый черновик
    const plain = await create({ typeId: types.get('memo'), subject: `Без ключа ${run}` })
    const plainAgain = await create({ typeId: types.get('memo'), subject: `Без ключа ${run}` })
    expect(plainAgain.json().id).not.toBe(plain.json().id)
  })

  it('два одновременных запроса с одним ключом создают один документ', async () => {
    const clientKey = randomUUID()
    const payload = { typeId: types.get('memo'), subject: `Гонка ${run}`, clientKey }
    const [a, b, c] = await Promise.all([create(payload), create(payload), create(payload)])
    for (const response of [a, b, c]) expect(response.statusCode, response.body).toBe(200)
    expect(new Set([a.json().id, b.json().id, c.json().id]).size).toBe(1)
    const rows = await db()
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.authorId, fx.users.member.id), eq(documents.clientKey, clientKey)))
    expect(rows).toHaveLength(1)
    expect(await createdEvents(a.json().id)).toBe(1)
  })

  it('ключ — по автору; тот же ключ с другим типом — отказ', async () => {
    const clientKey = randomUUID()
    const mine = await create({ typeId: types.get('memo'), clientKey })
    const theirs = await create({ typeId: types.get('memo'), clientKey }, fx.users.stranger)
    expect(theirs.statusCode, theirs.body).toBe(200)
    expect(theirs.json().id).not.toBe(mine.json().id)

    const otherType = [...types.entries()].find(([key]) => key !== 'memo')?.[1]
    const reused = await create({ typeId: otherType, clientKey })
    expect(reused.statusCode).toBe(409)
    expect(reused.json().code).toBe('conflict')
  })
})

describe('фото черновика', () => {
  let documentId = ''

  it('JPEG без метаданных прикреплён к документу; повтор с ключом снимка — тот же файл', async () => {
    const created = await create({ typeId: types.get('memo'), subject: `С фото ${run}` })
    documentId = created.json().id as string
    const clientKey = randomUUID()
    const upload = () =>
      call(fx.app, {
        method: 'POST',
        url: `/documents/${documentId}/photos`,
        as: fx.users.member,
        payload: { clientKey, data: photo('мост') },
      })
    const first = await upload()
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ clientKey, width: 1600, height: 900 })
    const [again, raced] = await Promise.all([upload(), upload()])
    expect(again.json().id).toBe(first.json().id)
    expect(raced.json().id).toBe(first.json().id)

    const attached = await db().select().from(links).where(eq(links.targetId, first.json().id))
    expect(attached.map((link) => [link.sourceId, link.kind])).toContainEqual([
      documentId,
      'attachment',
    ])
    const file = await call(fx.app, { url: `/files/${first.json().id}`, as: fx.users.member })
    expect(file.statusCode, file.body).toBe(200)
    expect(file.json()).toMatchObject({ mime: 'image/jpeg' })
  })

  it('не JPEG — отказ; чужой черновик — нет доступа', async () => {
    const notJpeg = await call(fx.app, {
      method: 'POST',
      url: `/documents/${documentId}/photos`,
      as: fx.users.member,
      payload: { clientKey: randomUUID(), data: Buffer.from('GIF89a……').toString('base64') },
    })
    expect(notJpeg.statusCode).toBe(400)
    const stranger = await call(fx.app, {
      method: 'POST',
      url: `/documents/${documentId}/photos`,
      as: fx.users.stranger,
      payload: { clientKey: randomUUID(), data: photo('чужой') },
    })
    expect([403, 404]).toContain(stranger.statusCode)
  })
})
