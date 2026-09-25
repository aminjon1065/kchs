import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { ObjectService } from '../src/kernel/objects/service.js'
import { TranscriptService } from '../src/modules/meetings/domain/transcript-service.js'
import { systemCtx } from '../src/shared/context.js'
import { recordings } from '../src/shared/db/schema/index.js'
import { newId } from '../src/shared/ids.js'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Правка расшифровки (ADR-0162): исправление фразы с пометкой и исходным
 * текстом, сопоставление говорящего с участником встречи, права `edit` на
 * записи, имена в черновике протокола. Медиасервер не нужен — запись и
 * расшифровка засеваются данными.
 */
registerLifecycle()

const run = Date.now().toString(36)

let fx: TestContext
let member: TestUser
let outsider: TestUser
let meetingId = ''
let recordingId = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

beforeAll(async () => {
  fx = await setupFixture()
  member = await createUser(fx.app, `tre_member_${run}`, ['employee'])
  outsider = await createUser(fx.app, `tre_out_${run}`, ['employee'])
  const created = await call(fx.app, {
    method: 'POST',
    url: '/meetings',
    as: fx.admin,
    payload: { title: `Штаб по паводку ${run}`, participantIds: [member.id] },
  })
  expect(created.statusCode, created.body).toBe(200)
  meetingId = created.json().id as string

  const [meeting] = await db().execute<{ space_id: string }>(
    sql`SELECT space_id FROM objects WHERE id = ${meetingId}`,
  )
  recordingId = newId()
  await db().transaction(async (tx) => {
    await ObjectService.create(tx, systemCtx('test'), {
      id: recordingId,
      type: 'recording',
      spaceId: meeting?.space_id ?? null,
      parentId: meetingId,
      title: `Штаб по паводку ${run}`,
      ownerId: fx.admin.id,
    })
    await tx.insert(recordings).values({
      id: recordingId,
      meetingId,
      status: 'ready',
      storageKey: `meetings/${meetingId}/${recordingId}.mp4`,
    })
  })
  await TranscriptService.save(recordingId, {
    status: 'ready',
    language: 'ru',
    model: 'test',
    durationSeconds: 30,
    segments: [
      { start: 0, end: 5, text: 'Докладываю обстановку по паводку', speaker: 'Говорящий 1' },
      {
        start: 5,
        end: 10,
        text: 'Уровень воды растёт на десять сантиметров',
        speaker: 'Говорящий 2',
      },
      { start: 10, end: 15, text: 'Эвакуацию готовим к вечеру', speaker: 'Говорящий 1' },
    ],
    error: null,
  })
})

const transcript = async (as: TestUser): Promise<Json> => {
  const response = await call(fx.app, { url: `/recordings/${recordingId}/transcript`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

const editSegment = (as: TestUser, index: number, text: string) =>
  call(fx.app, {
    method: 'PATCH',
    url: `/recordings/${recordingId}/transcript/segments/${index}`,
    as,
    payload: { text },
  })

const setSpeaker = (as: TestUser, label: string, userId: string | null) =>
  call(fx.app, {
    method: 'PUT',
    url: `/recordings/${recordingId}/transcript/speakers`,
    as,
    payload: { label, userId },
  })

describe('правка расшифровки', () => {
  it('говорящие перечислены в порядке появления, правка — только с правом edit', async () => {
    const forMember = await transcript(member)
    expect(forMember.speakers).toEqual([
      { label: 'Говорящий 1', user: null },
      { label: 'Говорящий 2', user: null },
    ])
    expect(forMember.can.edit).toBe(false)
    expect((await editSegment(member, 1, 'чужая правка')).statusCode).toBe(403)
    expect((await setSpeaker(member, 'Говорящий 1', member.id)).statusCode).toBe(403)
    expect((await editSegment(outsider, 1, 'посторонний')).statusCode).toBe(404)

    expect((await transcript(fx.admin)).can.edit).toBe(true)
  })

  it('исправленная фраза помечена и хранит текст распознавания; возврат снимает пометку', async () => {
    const edited = await editSegment(fx.admin, 1, 'Уровень воды растёт на двадцать сантиметров')
    expect(edited.statusCode, edited.body).toBe(200)
    const segment = edited.json().segments[1]
    expect(segment).toMatchObject({
      text: 'Уровень воды растёт на двадцать сантиметров',
      edited: true,
      original: 'Уровень воды растёт на десять сантиметров',
      start: 5,
      end: 10,
      speaker: 'Говорящий 2',
    })
    expect(edited.json().editedAt).not.toBeNull()

    // Вторая правка не теряет исходный текст распознавания
    const again = await editSegment(fx.admin, 1, 'Уровень воды растёт на 20 см')
    expect(again.json().segments[1].original).toBe('Уровень воды растёт на десять сантиметров')

    const restored = await editSegment(fx.admin, 1, 'Уровень воды растёт на десять сантиметров')
    expect(restored.json().segments[1]).toMatchObject({ edited: false, original: null })

    expect((await editSegment(fx.admin, 99, 'нет такой')).statusCode).toBe(404)
    expect((await editSegment(fx.admin, 0, '   ')).statusCode).toBe(400)

    const events = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ops.outbox
           WHERE type = 'transcript.edited' AND event->'object'->>'id' = ${recordingId}`,
    )
    expect(events[0]?.n).toBe(3)
  })

  it('говорящий сопоставляется только с участником встречи; имя — в черновике протокола', async () => {
    expect((await setSpeaker(fx.admin, 'Говорящий 1', outsider.id)).statusCode).toBe(400)
    expect((await setSpeaker(fx.admin, 'Говорящий 9', member.id)).statusCode).toBe(400)

    const mapped = await setSpeaker(fx.admin, 'Говорящий 1', member.id)
    expect(mapped.statusCode, mapped.body).toBe(200)
    expect(mapped.json().speakers[0].user.id).toBe(member.id)
    // Сама фраза хранит метку: имя подставляет выдача
    expect(mapped.json().segments[0].speaker).toBe('Говорящий 1')

    const organizer = await setSpeaker(fx.admin, 'Говорящий 2', fx.admin.id)
    expect(organizer.statusCode, organizer.body).toBe(200)

    const text = await TranscriptService.textOf(meetingId, 10_000)
    const name = mapped.json().speakers[0].user.displayName as string
    expect(text?.text.split('\n')[0]).toBe(`${name}: Докладываю обстановку по паводку`)

    const cleared = await setSpeaker(fx.admin, 'Говорящий 1', null)
    expect(cleared.json().speakers[0].user).toBeNull()
  })

  it('сопоставление переживает перерасшифровку, правки фраз — нет', async () => {
    await TranscriptService.save(recordingId, {
      status: 'ready',
      language: 'ru',
      model: 'test-2',
      durationSeconds: 30,
      segments: [{ start: 0, end: 5, text: 'Заново распознано', speaker: 'Говорящий 2' }],
      error: null,
    })
    const again = await transcript(fx.admin)
    expect(again.segments).toHaveLength(1)
    expect(again.segments[0].edited).toBe(false)
    expect(again.speakers).toEqual([
      { label: 'Говорящий 2', user: expect.objectContaining({ id: fx.admin.id }) },
    ])
  })
})
