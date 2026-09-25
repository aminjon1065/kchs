import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
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
 * Срок хранения записей встреч (N29, ADR-0138): за неделю до срока организатор
 * получает предупреждение, по сроку запись удаляется вместе с файлом;
 * закреплённые и связанные с протоколом или документом — не трогаются; срок —
 * настройка установки (0 — бессрочно).
 */
registerLifecycle()

const { ObjectService } = await import('../src/kernel/objects/service.js')
const { LinkService } = await import('../src/kernel/links/service.js')
const { RecordingService } = await import('../src/modules/meetings/domain/recording-service.js')
const { RecordingRetention, MeetingSettingsService } = await import(
  '../src/modules/meetings/domain/recording-retention.js'
)
const { ProtocolService } = await import('../src/modules/meetings/domain/protocol-service.js')
const { meetingsSpaceId } = await import('../src/modules/meetings/domain/space.js')
const { recordings } = await import('../src/shared/db/schema/index.js')
const { systemCtx } = await import('../src/shared/context.js')
const { newId } = await import('../src/shared/ids.js')

const run = Date.now().toString(36)
let fx: TestContext
let organizer: TestUser
let member: TestUser

async function createMeeting(title: string): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/meetings',
    as: organizer,
    payload: { title, participantIds: [member.id] },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

/** Готовая запись встречи, закончившаяся `monthsAgo` месяцев назад. */
async function readyRecording(meetingId: string, monthsAgo: number): Promise<string> {
  const id = newId()
  const ctx = systemCtx('test', { initiatorId: organizer.id })
  await db().transaction(async (tx) => {
    await ObjectService.create(tx, ctx, {
      id,
      type: 'recording',
      spaceId: await meetingsSpaceId(tx),
      parentId: meetingId,
      title: `Запись ${run}`,
      ownerId: organizer.id,
    })
    await tx.insert(recordings).values({
      id,
      meetingId,
      status: 'processing',
      storageKey: `meetings/${meetingId}/${id}.mp4`,
      startedBy: organizer.id,
    })
  })
  await RecordingService.markReady(id, {
    storageKey: `meetings/${meetingId}/${id}.mp4`,
    sizeBytes: 1024,
    durationSeconds: 60,
  })
  await db().execute(
    sql`UPDATE recordings SET ended_at = now() - make_interval(months => ${monthsAgo}) WHERE id = ${id}`,
  )
  return id
}

const exists = async (id: string) =>
  (
    await db().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM objects WHERE id = ${id}`)
  )[0]?.n === 1

beforeAll(async () => {
  fx = await setupFixture()
  organizer = await createUser(fx.app, `rec_org_${run}`, ['employee'])
  member = await createUser(fx.app, `rec_member_${run}`, ['employee'])
  await db().transaction((tx) =>
    MeetingSettingsService.update(tx, systemCtx('test'), { recordingRetentionMonths: 6 }),
  )
})

describe('срок хранения записей', () => {
  it('за неделю до срока — предупреждение организатору, по сроку — удаление с файлом', async () => {
    const meetingId = await createMeeting(`Штаб ${run}`)
    const recordingId = await readyRecording(meetingId, 7)
    const record = (await call(fx.app, { url: `/recordings/${recordingId}`, as: organizer })).json()
    expect(record.expiresAt).toBeTruthy()
    expect(record.can.pin).toBe(true)
    const fileId = record.fileId as string

    const first = await RecordingRetention.run(new Date())
    expect(first.warned).toBeGreaterThanOrEqual(1)
    const warned = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM notifications
           WHERE user_id = ${organizer.id} AND title_key = 'notifications.tpl.recordingExpiring'
             AND object_id = ${recordingId}`,
    )
    expect(warned[0]?.n).toBe(1)
    // Удаление — не раньше чем через неделю после предупреждения
    await RecordingRetention.run(new Date())
    expect(await exists(recordingId)).toBe(true)

    const later = await RecordingRetention.run(new Date(Date.now() + 8 * 86_400_000))
    expect(later.deleted).toBeGreaterThanOrEqual(1)
    expect(await exists(recordingId)).toBe(false)
    expect(await exists(fileId)).toBe(false)
  })

  it('закреплённая организатором запись не удаляется; участник закрепить не может', async () => {
    const meetingId = await createMeeting(`Совещание ${run}`)
    const recordingId = await readyRecording(meetingId, 8)
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/recordings/${recordingId}/pin`,
      as: member,
      payload: { pinned: true },
    })
    expect(byMember.statusCode).toBe(403)
    const pinned = await call(fx.app, {
      method: 'POST',
      url: `/recordings/${recordingId}/pin`,
      as: organizer,
      payload: { pinned: true },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json()).toMatchObject({ expiresAt: null })
    expect(pinned.json().pinnedAt).toBeTruthy()

    await RecordingRetention.run(new Date(Date.now() + 30 * 86_400_000))
    expect(await exists(recordingId)).toBe(true)
  })

  it('запись, попавшая в протокол, не удаляется', async () => {
    const meetingId = await createMeeting(`Планёрка ${run}`)
    const recordingId = await readyRecording(meetingId, 9)
    await db().transaction(async (tx) => {
      const protocolId = await ProtocolService.ensure(tx, systemCtx('test'), meetingId)
      await LinkService.link(tx, systemCtx('test'), protocolId, recordingId, 'source')
    })
    const record = (await call(fx.app, { url: `/recordings/${recordingId}`, as: organizer })).json()
    expect(record.expiresAt).toBeNull()

    await RecordingRetention.run(new Date(Date.now() + 30 * 86_400_000))
    expect(await exists(recordingId)).toBe(true)
  })

  it('срок — настройка установки: 0 — хранить бессрочно', async () => {
    const byMember = await call(fx.app, { url: '/admin/meetings/settings', as: member })
    expect(byMember.statusCode).toBe(403)
    const saved = await call(fx.app, {
      method: 'PUT',
      url: '/admin/meetings/settings',
      as: fx.admin,
      payload: { recordingRetentionMonths: 0 },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const settings = (await call(fx.app, { url: '/admin/meetings/settings', as: fx.admin })).json()
    expect(settings).toEqual({ recordingRetentionMonths: 0 })

    const meetingId = await createMeeting(`Архивная встреча ${run}`)
    const recordingId = await readyRecording(meetingId, 30)
    const record = (await call(fx.app, { url: `/recordings/${recordingId}`, as: organizer })).json()
    expect(record.expiresAt).toBeNull()
    expect(await RecordingRetention.run(new Date(Date.now() + 90 * 86_400_000))).toEqual({
      warned: 0,
      deleted: 0,
    })
    expect(await exists(recordingId)).toBe(true)

    // Вернуть умолчание: другие тесты стенда ждут срок в 6 месяцев
    await call(fx.app, {
      method: 'PUT',
      url: '/admin/meetings/settings',
      as: fx.admin,
      payload: { recordingRetentionMonths: 6 },
    })
  })
})
