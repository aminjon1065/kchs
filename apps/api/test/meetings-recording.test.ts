import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { AccessToken } from 'livekit-server-sdk'
import { beforeAll, describe, expect, it, vi } from 'vitest'
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
 * Запись встречи и её расшифровка (P4-E02 S05–S06, ADR-0092). Медиасервер
 * подменён: задание Egress не запускается, а его вебхук приходит подписанным
 * ключом установки — так проверяются и права, и путь «запись готова → файл →
 * расшифровка». Посторонний не видит ни встречи, ни записи, ни расшифровки.
 */
const egress = vi.hoisted(() => ({
  started: [] as Array<{ roomName: string; storageKey: string; egressId: string }>,
  stopped: [] as string[],
}))

vi.mock('../src/modules/meetings/domain/recording-egress.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/meetings/domain/recording-egress.js')>()
  return {
    ...actual,
    startRoomRecording: async (roomName: string, storageKey: string) => {
      // Идентификатор задания у медиасервера уникален — как и у настоящего Egress
      const egressId = `EG_test_${egress.started.length + 1}`
      egress.started.push({ roomName, storageKey, egressId })
      return { egressId }
    },
    stopRoomRecording: async (egressId: string) => {
      egress.stopped.push(egressId)
    },
    egressInfo: async () => null,
  }
})

registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/index.js')

const run = Date.now().toString(36)
const MEDIA = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: `key_${run}`,
  LIVEKIT_API_SECRET: 'secret_for_tests_at_least_32_characters_long',
}
const serviceToken = process.env.INTERNAL_SERVICE_TOKEN ?? ''

let fx: TestContext
let member: TestUser
let outsider: TestUser
let meetingId = ''
let recordingId = ''
let mainEgressId = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

/** Подпись вебхука LiveKit: JWT ключом установки с хэшем тела. */
async function signedWebhook(body: string): Promise<string> {
  const token = new AccessToken(MEDIA.LIVEKIT_API_KEY, MEDIA.LIVEKIT_API_SECRET, { ttl: 300 })
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}

async function postWebhook(body: string, authHeader?: string) {
  return call(fx.app, {
    method: 'POST',
    url: '/meetings/webhooks/livekit',
    payload: body,
    headers: {
      'content-type': 'application/webhook+json',
      ...(authHeader ? { authorization: authHeader } : {}),
    },
  })
}

beforeAll(async () => {
  fx = await setupFixture()
  member = await createUser(fx.app, `rec_member_${run}`, ['employee'])
  outsider = await createUser(fx.app, `rec_out_${run}`, ['employee'])
  for (const [key, value] of Object.entries(MEDIA)) process.env[key] = value
  resetConfigCache()

  const created = await call(fx.app, {
    method: 'POST',
    url: '/meetings',
    as: fx.admin,
    payload: { title: `Совещание с записью ${run}`, participantIds: [member.id] },
  })
  expect(created.statusCode, created.body).toBe(200)
  meetingId = created.json().id as string
})

describe('право на запись', () => {
  it('участник без способности не включает запись, посторонний не видит встречи', async () => {
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/recording/start`,
      as: member,
    })
    expect(byMember.statusCode, byMember.body).toBe(403)

    const byOutsider = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/recording/start`,
      as: outsider,
    })
    expect(byOutsider.statusCode).toBe(404)
  })

  it('ведущий со способностью `meetings.record` включает запись', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/recording/start`,
      as: fx.admin,
    })
    expect(started.statusCode, started.body).toBe(200)
    const record = started.json() as Json
    recordingId = record.id
    expect(record).toMatchObject({
      meetingId,
      status: 'active',
      transcriptStatus: 'off',
      fileId: null,
    })
    expect(record.startedBy.id).toBe(fx.admin.id)
    expect(egress.started.at(-1)).toMatchObject({ roomName: `meeting-${meetingId}` })
    expect(egress.started.at(-1)?.storageKey).toBe(`meetings/${meetingId}/${recordingId}.mp4`)
    mainEgressId = egress.started.at(-1)?.egressId ?? ''
  })

  it('индикатор записи виден всем участникам встречи', async () => {
    const asMember = await call(fx.app, { url: `/meetings/${meetingId}`, as: member })
    expect(asMember.statusCode, asMember.body).toBe(200)
    expect(asMember.json().recording).toMatchObject({ id: recordingId, status: 'active' })
    expect(asMember.json().can.record).toBe(false)
  })

  it('вторая запись той же встречи не заводится', async () => {
    const again = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/recording/start`,
      as: fx.admin,
    })
    expect(again.statusCode).toBe(409)
  })

  it('останавливает запись только тот, кто её мог включить', async () => {
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/recordings/${recordingId}/stop`,
      as: member,
    })
    expect(byMember.statusCode).toBe(403)

    const stopped = await call(fx.app, {
      method: 'POST',
      url: `/recordings/${recordingId}/stop`,
      as: fx.admin,
    })
    expect(stopped.statusCode, stopped.body).toBe(200)
    expect(stopped.json()).toMatchObject({ status: 'processing', can: { stop: false } })
    expect(egress.stopped).toContain(mainEgressId)
  })
})

describe('вебхук медиасервера', () => {
  const body = () =>
    JSON.stringify({
      event: 'egress_ended',
      id: `WH_${run}`,
      createdAt: `${Math.floor(Date.now() / 1000)}`,
      egressInfo: {
        egressId: mainEgressId,
        roomName: `meeting-${meetingId}`,
        status: 'EGRESS_COMPLETE',
        fileResults: [
          {
            filename: `meetings/${meetingId}/${recordingId}.mp4`,
            size: '4096',
            duration: '95000000000',
          },
        ],
      },
    })

  it('без подписи и с чужой подписью — отказ', async () => {
    const unsigned = await postWebhook(body())
    expect(unsigned.statusCode).toBe(401)

    const foreign = new AccessToken('other_key', 'another_secret_at_least_32_characters', {
      ttl: 300,
    })
    foreign.sha256 = createHash('sha256').update(body()).digest('base64')
    const wrong = await postWebhook(body(), await foreign.toJwt())
    expect(wrong.statusCode).toBe(401)

    const record = await call(fx.app, { url: `/recordings/${recordingId}`, as: fx.admin })
    expect(record.json().status).toBe('processing')
  })

  it('подписанное «запись готова» создаёт файл и ставит расшифровку', async () => {
    const payload = body()
    const response = await postWebhook(payload, await signedWebhook(payload))
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ ok: true, handled: true })

    const record = await call(fx.app, { url: `/recordings/${recordingId}`, as: fx.admin })
    const json = record.json() as Json
    expect(json).toMatchObject({
      status: 'ready',
      durationSeconds: 95,
      sizeBytes: 4096,
      transcriptStatus: 'queued',
    })
    expect(json.fileId).toBeTruthy()

    // Файл записи — объект реестра, прикреплённый к записи
    const file = await call(fx.app, { url: `/files/${json.fileId}`, as: fx.admin })
    expect(file.statusCode, file.body).toBe(200)
    expect(file.json().mime).toBe('video/mp4')

    // Задание расшифровки поставлено движку
    const jobs = await db().execute<{ queue: string; name: string; payload: Json }>(
      sql`SELECT queue, name, payload FROM jobs
           WHERE object_id = ${recordingId} ORDER BY created_at DESC LIMIT 1`,
    )
    expect(jobs[0]).toMatchObject({ queue: 'media', name: 'media.transcribe' })
    expect(jobs[0]?.payload.storageKey).toBe(`meetings/${meetingId}/${recordingId}.mp4`)
  })

  it('повторная доставка того же события ничего не ломает', async () => {
    const payload = body()
    const response = await postWebhook(payload, await signedWebhook(payload))
    expect(response.statusCode, response.body).toBe(200)
    const record = await call(fx.app, { url: `/recordings/${recordingId}`, as: fx.admin })
    expect(record.json().status).toBe('ready')
  })
})

describe('доступ к записи и расшифровке', () => {
  it('участник видит запись, посторонний получает 404', async () => {
    const asMember = await call(fx.app, { url: `/recordings/${recordingId}`, as: member })
    expect(asMember.statusCode, asMember.body).toBe(200)
    expect(asMember.json().can.stop).toBe(false)

    const asOutsider = await call(fx.app, { url: `/recordings/${recordingId}`, as: outsider })
    expect(asOutsider.statusCode).toBe(404)

    const list = await call(fx.app, { url: `/meetings/${meetingId}/recordings`, as: member })
    expect(list.statusCode, list.body).toBe(200)
    expect((list.json().items as Json[]).map((item) => item.id)).toEqual([recordingId])

    const strangerList = await call(fx.app, {
      url: `/meetings/${meetingId}/recordings`,
      as: outsider,
    })
    expect(strangerList.statusCode).toBe(404)
  })

  it('движок сообщает расшифровку служебным токеном, посторонний её не читает', async () => {
    const result = {
      status: 'ready',
      language: 'ru',
      model: 'small',
      durationSeconds: 95,
      segments: [
        { start: 0, end: 4.5, text: 'Добрый день, начинаем совещание', speaker: null },
        { start: 4.5, end: 9, text: 'Первый вопрос — паводок', speaker: null },
      ],
    }

    const withoutToken = await call(fx.app, {
      method: 'POST',
      url: `/internal/meetings/recordings/${recordingId}/transcript`,
      payload: result,
    })
    expect(withoutToken.statusCode).toBe(401)

    const reported = await call(fx.app, {
      method: 'POST',
      url: `/internal/meetings/recordings/${recordingId}/transcript`,
      headers: { 'x-kchs-service-token': serviceToken },
      payload: result,
    })
    expect(reported.statusCode, reported.body).toBe(200)

    const transcript = await call(fx.app, {
      url: `/recordings/${recordingId}/transcript`,
      as: member,
    })
    expect(transcript.statusCode, transcript.body).toBe(200)
    expect(transcript.json()).toMatchObject({ status: 'ready', language: 'ru', model: 'small' })
    expect((transcript.json().segments as Json[]).map((item) => item.text)).toEqual([
      'Добрый день, начинаем совещание',
      'Первый вопрос — паводок',
    ])

    const asOutsider = await call(fx.app, {
      url: `/recordings/${recordingId}/transcript`,
      as: outsider,
    })
    expect(asOutsider.statusCode).toBe(404)

    const record = await call(fx.app, { url: `/recordings/${recordingId}`, as: member })
    expect(record.json().transcriptStatus).toBe('ready')
  })

  it('без модели распознавания расшифровка помечается недоступной', async () => {
    const second = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: fx.admin,
      payload: { title: `Планёрка без расшифровки ${run}`, participantIds: [member.id] },
    })
    const otherMeeting = second.json().id as string
    const started = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${otherMeeting}/recording/start`,
      as: fx.admin,
    })
    const otherRecording = started.json().id as string

    const reported = await call(fx.app, {
      method: 'POST',
      url: `/internal/meetings/recordings/${otherRecording}/transcript`,
      headers: { 'x-kchs-service-token': serviceToken },
      payload: {
        status: 'unavailable',
        error: 'модель распознавания речи не настроена',
        segments: [],
      },
    })
    expect(reported.statusCode, reported.body).toBe(200)

    const transcript = await call(fx.app, {
      url: `/recordings/${otherRecording}/transcript`,
      as: member,
    })
    expect(transcript.json()).toMatchObject({ status: 'unavailable', segments: [] })
  })

  it('завершение встречи останавливает идущую запись', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/meetings',
      as: fx.admin,
      payload: { title: `Запись до конца встречи ${run}`, participantIds: [] },
    })
    const id = created.json().id as string
    const started = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${id}/recording/start`,
      as: fx.admin,
    })
    expect(started.statusCode, started.body).toBe(200)

    const ended = await call(fx.app, { method: 'POST', url: `/meetings/${id}/end`, as: fx.admin })
    expect(ended.statusCode, ended.body).toBe(200)
    expect(ended.json().recording).toBeNull()

    const record = await call(fx.app, {
      url: `/recordings/${started.json().id}`,
      as: fx.admin,
    })
    expect(record.json().status).toBe('processing')
  })
})
