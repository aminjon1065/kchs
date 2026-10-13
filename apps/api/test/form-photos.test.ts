import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createServiceAccount,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Фото сводки (ADR-0208): поле датасета `file` форма спрашивает снимком; сервер
 * принимает только JPEG, выбрасывает EXIF с координатами, кладёт файл реестра,
 * прикреплённый к форме; повтор с тем же ключом устройства не плодит файлов; сдача
 * принимает только снимки этой сводки, прикрепляет их к датасету и замораживает,
 * а снимки черновика, не вошедшие в сдачу, удаляет.
 */
registerLifecycle()

const { links } = await import('../src/db-schema.js')
const { getObjectStream } = await import('../src/kernel/storage/s3.js')
const { fileSource } = await import('../src/modules/files/public.js')

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''
let formId = ''
let submissionId = ''
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

const segment = (marker: number, data: Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0])
  head.writeUInt16BE(data.byteLength + 2, 2)
  return Buffer.concat([head, data])
}

/** JPEG по структуре, с EXIF и координатами съёмки — их сервер обязан выбросить. */
function photo(label: string): string {
  const frame = Buffer.alloc(6)
  frame[0] = 8
  frame.writeUInt16BE(1200, 1)
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

async function stored(fileId: string): Promise<Buffer> {
  const source = await fileSource(fileId)
  if (!source) throw new Error('нет файла')
  const { body } = await getObjectStream(source.storageKey)
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

const upload = (clientKey: string, data: string, fieldKey = 'photo', as = fx.users.member) =>
  call(fx.app, {
    method: 'POST',
    url: `/forms/submissions/${submissionId}/photos`,
    as,
    payload: { clientKey, fieldKey, data },
  })

beforeAll(async () => {
  fx = await setupFixture()
  const writer = await createServiceAccount(fx.app, fx.admin, `Фото ${run}`, [fx.spaceId])
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Осмотр места ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'note', label: { ru: 'Что видно' }, type: 'text' },
        { key: 'photo', label: { ru: 'Фото' }, type: 'file' },
      ],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id as string
  const created = await call(fx.app, {
    method: 'POST',
    url: '/forms',
    as: fx.admin,
    payload: {
      name: `Осмотр ${run}`,
      spaceId: fx.spaceId,
      runAs: writer,
      definition: {
        datasetId,
        fields: [
          { key: 'note', required: true, hint: null },
          { key: 'photo', required: true, hint: null },
        ],
        schedule: { periodicity: 'daily', time: '08:00', dueWorkingDays: 1 },
        assignments: [{ kind: 'unit', id: fx.unitId }],
        review: { enabled: true, reviewers: [`user:${fx.admin.id}`] },
      },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  formId = created.json().id as string
  const opened = await call(fx.app, {
    method: 'POST',
    url: `/forms/${formId}/submissions`,
    as: fx.users.member,
    payload: { periodKey: yesterday, subject: { kind: 'unit', id: fx.unitId } },
  })
  expect(opened.statusCode, opened.body).toBe(200)
  submissionId = opened.json().id as string
})

describe('фото сводки', () => {
  let first = ''
  let second = ''

  it('схема формы спрашивает поле-файл', async () => {
    const schema = await call(fx.app, { url: `/forms/${formId}/schema`, as: fx.users.member })
    expect(schema.statusCode, schema.body).toBe(200)
    expect(schema.json().fields.map((field: { type: string }) => field.type)).toContain('file')
  })

  it('JPEG без EXIF, файл реестра у формы; повтор с тем же ключом — тот же файл', async () => {
    const key = randomUUID()
    const saved = await upload(key, photo('первый снимок'))
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()).toMatchObject({ clientKey: key, fieldKey: 'photo', width: 1600 })
    first = saved.json().id as string
    const again = await upload(key, photo('первый снимок'))
    expect(again.json().id).toBe(first)

    const bytes = await stored(first)
    expect(bytes.includes(Buffer.from('GPSLatitude'))).toBe(false)
    expect(bytes.includes(Buffer.from('первый снимок', 'utf8'))).toBe(true)
    const file = await call(fx.app, { url: `/files/${first}`, as: fx.users.member })
    expect(file.statusCode, file.body).toBe(200)
    expect(file.json()).toMatchObject({ mime: 'image/jpeg' })
    // Посторонний сводку не видит — и снимок тоже
    const stranger = await call(fx.app, { url: `/files/${first}`, as: fx.users.stranger })
    expect([403, 404]).toContain(stranger.statusCode)
  })

  it('не JPEG, не фото-поле и не назначенный — отказ', async () => {
    const gif = Buffer.from('GIF89a……').toString('base64')
    expect((await upload(randomUUID(), gif)).statusCode).toBe(400)
    expect((await upload(randomUUID(), photo('x'), 'note')).statusCode).toBe(400)
    const stranger = await upload(randomUUID(), photo('x'), 'photo', fx.users.stranger)
    expect([403, 404]).toContain(stranger.statusCode)
  })

  it('значение поля — только снимок этой сводки', async () => {
    const foreign = await call(fx.app, {
      method: 'PUT',
      url: `/forms/submissions/${submissionId}`,
      as: fx.users.member,
      payload: { values: { note: 'черновик', photo: randomUUID() } },
    })
    expect(foreign.statusCode).toBe(400)
    const draft = await call(fx.app, {
      method: 'PUT',
      url: `/forms/submissions/${submissionId}`,
      as: fx.users.member,
      payload: { values: { note: 'черновик', photo: first } },
    })
    expect(draft.statusCode, draft.body).toBe(200)
  })

  it('сдача: снимок в строке и у датасета, заменённый удалён, сданный заморожен', async () => {
    const replaced = await upload(randomUUID(), photo('второй снимок'))
    expect(replaced.statusCode, replaced.body).toBe(200)
    second = replaced.json().id as string

    const submitted = await call(fx.app, {
      method: 'POST',
      url: `/forms/submissions/${submissionId}/submit`,
      as: fx.users.member,
      payload: { values: { note: 'обрушение моста', photo: second }, clientKey: randomUUID() },
    })
    expect(submitted.statusCode, submitted.body).toBe(200)
    const row = await call(fx.app, {
      url: `/datasets/${datasetId}/rows/${submitted.json().rowId}`,
      as: fx.admin,
    })
    expect(row.json().values.photo).toBe(second)
    const attached = await db().select().from(links).where(eq(links.targetId, second))
    expect(attached.map((link) => [link.sourceId, link.kind])).toEqual(
      expect.arrayContaining([
        [formId, 'attachment'],
        [datasetId, 'attachment'],
      ]),
    )

    // Снимок черновика, не вошедший в сдачу, удалён насовсем
    expect((await call(fx.app, { url: `/files/${first}`, as: fx.admin })).statusCode).toBe(404)
    // Сданный не удалить и не заменить — даже администратору
    const trash = await call(fx.app, { method: 'DELETE', url: `/objects/${second}`, as: fx.admin })
    expect(trash.statusCode).toBe(409)
    expect(trash.body).toContain('сданную сводку')
    // После сдачи новых снимков в сводку нет
    expect((await upload(randomUUID(), photo('поздний'))).statusCode).toBe(409)
  })
})
