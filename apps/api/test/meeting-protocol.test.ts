import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type FakeAi, startFakeAi } from './fakes.js'
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
 * Протокол встречи (P4-E02 S07, ADR-0093): повестка и протокол — один
 * совместный документ; черновик ИИ предлагает решения и поручения, ничего не
 * создавая; подтверждение превращает блоки в поручения, регистрация — в
 * документ, ознакомление ведёт ядро. Участник видит протокол, посторонний — нет.
 * Модель — поддельный сервер, расшифровки в этой ветке нет.
 */
registerLifecycle()

const { startCollab, stopCollab } = await import('../src/kernel/collab/server.js')
const { AuthService } = await import('../src/modules/identity/public.js')
const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { setTranscriptSource } = await import(
  '../src/modules/meetings/domain/protocol-transcript.js'
)
const { resetConfigCache } = await import('../src/shared/config/index.js')
const { systemCtx } = await import('../src/shared/context.js')

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const run = Date.now().toString(36)

let fx: TestContext
let ai: FakeAi
let organizer: TestUser
let member: TestUser
let outsider: TestUser
let protocolTypeId = ''

function configureAi(on: boolean): void {
  if (on) {
    process.env.AI_PROVIDER = 'anthropic'
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.ANTHROPIC_BASE_URL = ai.url
  } else {
    delete process.env.AI_PROVIDER
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
  }
  resetConfigCache()
}

/** Встреча со звонком из беседы: организатор и приглашённый участник. */
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

async function createProtocol(meetingId: string, as = organizer) {
  return call(fx.app, { method: 'POST', url: `/meetings/${meetingId}/protocol`, as })
}

const protocolOf = async (id: string, as = organizer): Promise<Json> =>
  (await call(fx.app, { url: `/protocols/${id}`, as })).json()

/** Подписчики ядра и встреч по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'meetings-protocol-review')) {
    const { registerMeetingsBackground } = await import('../src/modules/meetings/module.js')
    registerMeetingsBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

/** Завтрашняя дата — срок предложенного поручения. */
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  fx = await setupFixture()
  await fx.app.listen({ port: 0, host: '127.0.0.1' })
  startCollab(fx.app.server, { resolveSession: (token) => AuthService.resolveSession(token) })
  ai = await startFakeAi()
  organizer = await createUser(fx.app, `proto_org_${run}`, ['employee', 'registrar'])
  member = await createUser(fx.app, `proto_member_${run}`, ['employee'])
  outsider = await createUser(fx.app, `proto_out_${run}`, ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: false })
  const types = await call(fx.app, { url: '/document-types', as: fx.admin })
  const list = types.json().items as Array<{ id: string; key: string }>
  protocolTypeId = (list.find((item) => item.key === 'protocol') ?? list[0])?.id ?? ''
  expect(protocolTypeId).not.toBe('')
})

afterAll(async () => {
  setTranscriptSource(null)
  configureAi(false)
  await ai?.close()
  await stopCollab()
})

describe('повестка и права', () => {
  let meetingId = ''
  let protocolId = ''

  it('протокол заводит тот, кто распоряжается встречей', async () => {
    meetingId = await createMeeting(`Совещание по паводку ${run}`)
    const empty = await call(fx.app, { url: `/meetings/${meetingId}/protocol`, as: organizer })
    expect(empty.statusCode, empty.body).toBe(200)
    expect(empty.json().protocol).toBeNull()

    // Приглашённый участник ведёт протокол, но не заводит его
    const byMember = await createProtocol(meetingId, member)
    expect(byMember.statusCode).toBe(403)
    const byOutsider = await createProtocol(meetingId, outsider)
    expect(byOutsider.statusCode).toBe(404)

    const created = await createProtocol(meetingId)
    expect(created.statusCode, created.body).toBe(200)
    protocolId = created.json().id
    expect(created.json()).toMatchObject({
      meetingId,
      status: 'agenda',
      blocks: [],
      documentId: null,
      instructions: [],
      can: { edit: true, confirm: true, register: false, requestAcknowledgment: false },
    })
    // Повторный вызов возвращает тот же протокол
    expect((await createProtocol(meetingId)).json().id).toBe(protocolId)
  })

  it('участник читает и обсуждает протокол, посторонний получает 404', async () => {
    const asMember = await call(fx.app, { url: `/protocols/${protocolId}`, as: member })
    expect(asMember.statusCode, asMember.body).toBe(200)
    // Правят организатор и секретарь (N30): рядовой участник только читает
    expect(asMember.json().can).toMatchObject({
      edit: false,
      confirm: false,
      register: false,
      requestAcknowledgment: false,
    })
    const blocks = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/blocks`,
      as: member,
      payload: { blocks: [{ id: 'm1', kind: 'note', title: 'Замечание участника' }] },
    })
    expect(blocks.statusCode).toBe(403)
    const asOutsider = await call(fx.app, { url: `/protocols/${protocolId}`, as: outsider })
    expect(asOutsider.statusCode).toBe(404)
    const throughMeeting = await call(fx.app, {
      url: `/meetings/${meetingId}/protocol`,
      as: outsider,
    })
    expect(throughMeeting.statusCode).toBe(404)
  })
})

describe('черновик ИИ, подтверждение, документ и ознакомление', () => {
  let meetingId = ''
  let protocolId = ''
  let documentId = ''

  it('без модели черновик недоступен', async () => {
    configureAi(false)
    meetingId = await createMeeting(`Штаб по водоснабжению ${run}`)
    protocolId = (await createProtocol(meetingId)).json().id
    expect((await protocolOf(protocolId)).can.draft).toBe(false)
    const response = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/draft`,
      as: organizer,
    })
    expect(response.statusCode).toBe(503)
    expect(response.json().data.reason).toBe('ai_disabled')
  })

  it('черновик по повестке: решения и поручения предложены, ничего не создано', async () => {
    configureAi(true)
    // Повестка — блоки совместного документа; сервер пишет в него так же, как клиент
    const agenda = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/blocks`,
      as: organizer,
      payload: {
        blocks: [{ id: 'agenda1', kind: 'agenda_item', title: 'Готовность насосных станций' }],
      },
    })
    expect(agenda.statusCode, agenda.body).toBe(200)
    expect(agenda.json().blocks).toHaveLength(1)

    ai.reply({
      summary: 'Обсудили готовность насосных станций и сроки их проверки.',
      decisions: [{ title: 'Проверить насосные станции', text: 'Проверку провести выездом.' }],
      instructions: [
        {
          title: 'Обследовать насосные станции района',
          text: 'С выездом на место, с фотофиксацией.',
          assignee: 2,
          controller: 1,
          due: tomorrow,
        },
      ],
    })
    const draft = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/draft`,
      as: organizer,
    })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json()).toMatchObject({ usedTranscript: false, truncated: false })
    expect(draft.json().added).toHaveLength(2)

    const record = await protocolOf(protocolId)
    expect(record.status).toBe('draft')
    expect(record.summary).toContain('насосных станций')
    const instruction = (record.blocks as Json[]).find((b: Json) => b.kind === 'instruction')
    expect(instruction.dueAt).toBe(tomorrow)
    expect([organizer.id, member.id]).toContain(instruction.assigneeId)
    // Поручений ещё нет: черновик — только предложение
    expect(record.instructions).toEqual([])
  })

  it('подтверждение создаёт поручения из блоков и закрывает правку', async () => {
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/confirm`,
      as: member,
    })
    expect(byMember.statusCode).toBe(403)

    const confirmed = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/confirm`,
      as: organizer,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const record = confirmed.json() as Json
    expect(record.status).toBe('confirmed')
    expect(record.confirmedBy.id).toBe(organizer.id)
    expect(record.instructions).toHaveLength(1)
    expect(record.instructions[0]).toMatchObject({ accessible: true, status: 'assigned' })
    expect(record.instructions[0].key).toMatch(/-\d+$/)
    expect(record.can).toMatchObject({ edit: false, confirm: false, register: true })

    // Поручение — настоящая задача с источником-протоколом
    const task = await call(fx.app, {
      url: `/tasks/${record.instructions[0].taskId}`,
      as: organizer,
    })
    expect(task.statusCode, task.body).toBe(200)
    expect(task.json().source).toMatchObject({ kind: 'object', objectId: protocolId })
    expect(task.json().kind).toBe('instruction')

    // Повторное подтверждение — конфликт, второго поручения не будет
    const again = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/confirm`,
      as: organizer,
    })
    expect(again.statusCode).toBe(409)
  })

  it('регистрация документом: документ заведён и связан с протоколом', async () => {
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/register`,
      as: member,
      payload: { typeId: protocolTypeId },
    })
    expect(byMember.statusCode).toBe(403)

    const registered = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/register`,
      as: organizer,
      payload: { typeId: protocolTypeId },
    })
    expect(registered.statusCode, registered.body).toBe(200)
    documentId = registered.json().documentId
    const document = await call(fx.app, { url: `/documents/${documentId}`, as: organizer })
    expect(document.statusCode, document.body).toBe(200)
    expect(document.json().status).toBe('draft')
    expect(document.json().summary).toContain('насосных станций')

    const record = await protocolOf(protocolId)
    expect(record.documentId).toBe(documentId)
    expect(record.can.register).toBe(false)
    const links = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM links
           WHERE source_id = ${protocolId} AND target_id = ${documentId}`,
    )
    expect(links[0]?.n).toBe(1)

    // Второй раз документом не регистрируется
    const twice = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/register`,
      as: organizer,
      payload: { typeId: protocolTypeId },
    })
    expect(twice.statusCode).toBe(409)
  })

  it('ознакомление участников ведёт ядро', async () => {
    const requested = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/acknowledgments`,
      as: organizer,
      payload: {},
    })
    expect(requested.statusCode, requested.body).toBe(200)
    expect(requested.json().requested).toBeGreaterThan(0)
    expect((await protocolOf(protocolId)).acknowledgmentRequested).toBe(true)

    const list = await call(fx.app, {
      url: `/objects/${protocolId}/acknowledgments`,
      as: member,
    })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().mine).toMatchObject({ pending: true })

    // Отправителя просить незачем: он же протокол и подтвердил
    const mineAsOrganizer = await call(fx.app, {
      url: `/objects/${protocolId}/acknowledgments`,
      as: organizer,
    })
    expect(mineAsOrganizer.json().mine).toMatchObject({ pending: false })

    const acknowledged = await call(fx.app, {
      method: 'POST',
      url: `/objects/${protocolId}/acknowledgments/acknowledge`,
      as: member,
      payload: {},
    })
    expect(acknowledged.statusCode, acknowledged.body).toBe(200)
    const mine = acknowledged.json().items.find((item: Json) => item.user.id === member.id)
    expect(mine.state).toBe('acknowledged')
  })

  it('поручение без исполнителя подтвердить нельзя', async () => {
    const otherMeeting = await createMeeting(`Планёрка ${run}`)
    const other = (await createProtocol(otherMeeting)).json().id as string
    await call(fx.app, {
      method: 'POST',
      url: `/protocols/${other}/blocks`,
      as: organizer,
      payload: { blocks: [{ id: 'agenda1', kind: 'agenda_item', title: 'Разное' }] },
    })
    ai.reply({
      summary: 'Короткая планёрка.',
      decisions: [],
      instructions: [
        {
          title: 'Кто-нибудь уточнит сроки',
          text: '',
          assignee: null,
          controller: null,
          due: null,
        },
      ],
    })
    const draft = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${other}/draft`,
      as: organizer,
    })
    expect(draft.statusCode, draft.body).toBe(200)
    const confirmed = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${other}/confirm`,
      as: organizer,
    })
    expect(confirmed.statusCode).toBe(409)
    expect(confirmed.json().data.blockIds).toHaveLength(1)
    expect((await protocolOf(other)).status).toBe('draft')
  })
})

describe('секретарь встречи (N30)', () => {
  const setSecretary = (meetingId: string, userId: string | null, as = organizer) =>
    call(fx.app, {
      method: 'PUT',
      url: `/meetings/${meetingId}/secretary`,
      as,
      payload: { userId },
    })

  it('организатор назначает секретаря — тот правит протокол, снятый теряет право', async () => {
    const meetingId = await createMeeting(`Заседание штаба ${run}`)

    // Назначает только организатор и только участника встречи
    expect((await setSecretary(meetingId, member.id, member)).statusCode).toBe(403)
    expect((await setSecretary(meetingId, outsider.id)).statusCode).toBe(400)
    expect((await setSecretary(meetingId, organizer.id)).statusCode).toBe(400)

    // Протокола ещё нет: назначение заводит его, секретарю есть что вести
    const assigned = await setSecretary(meetingId, member.id)
    expect(assigned.statusCode, assigned.body).toBe(200)
    const roles = new Map(
      (assigned.json().participants as Json[]).map((item: Json) => [item.user.id, item.role]),
    )
    expect(roles.get(member.id)).toBe('secretary')
    expect(roles.get(organizer.id)).toBe('organizer')

    const protocol = await call(fx.app, { url: `/meetings/${meetingId}/protocol`, as: member })
    const protocolId = protocol.json().protocol.id as string
    expect(protocol.json().protocol.can).toMatchObject({ edit: true, confirm: false })
    const added = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/blocks`,
      as: member,
      payload: { blocks: [{ id: 's1', kind: 'agenda_item', title: 'Доклад секретаря' }] },
    })
    expect(added.statusCode, added.body).toBe(200)
    // Подтверждение — по-прежнему за организатором
    const confirm = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/confirm`,
      as: member,
    })
    expect(confirm.statusCode).toBe(403)

    // Секретаря сняли — правка закрыта, чтение осталось
    const removed = await setSecretary(meetingId, null)
    expect(removed.statusCode, removed.body).toBe(200)
    expect((await protocolOf(protocolId, member)).can.edit).toBe(false)
  })

  it('секретарь, убранный из участников, теряет и право правки протокола', async () => {
    const meetingId = await createMeeting(`Совещание с секретарём ${run}`)
    expect((await setSecretary(meetingId, member.id)).statusCode).toBe(200)
    const protocolId = (
      await protocolOf(
        (await call(fx.app, { url: `/meetings/${meetingId}/protocol`, as: organizer })).json()
          .protocol.id,
      )
    ).id as string
    const { MeetingService } = await import('../src/modules/meetings/domain/meeting-service.js')
    await db().transaction((tx) =>
      MeetingService.setParticipants(tx, systemCtx('test'), meetingId, [outsider.id]),
    )
    const aclRows = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM acl_entries
           WHERE object_id = ${protocolId} AND principal_id = ${member.id}`,
    )
    expect(aclRows[0]?.n).toBe(0)
  })
})

describe('срок поручения по умолчанию (N33)', () => {
  it('поручению без названного срока ставится 10 рабочих дней', async () => {
    const meetingId = await createMeeting(`Штаб без сроков ${run}`)
    const protocolId = (await createProtocol(meetingId)).json().id as string
    const added = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/blocks`,
      as: organizer,
      payload: {
        blocks: [
          {
            id: 'instr1',
            kind: 'instruction',
            title: 'Подготовить справку о готовности',
            assigneeId: member.id,
          },
        ],
      },
    })
    expect(added.statusCode, added.body).toBe(200)
    const confirmed = await call(fx.app, {
      method: 'POST',
      url: `/protocols/${protocolId}/confirm`,
      as: organizer,
    })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const [instruction] = confirmed.json().instructions as Json[]
    expect(instruction.dueAt).toBeTruthy()
    // 10 рабочих дней — не меньше двух календарных недель и не больше месяца
    const days = (Date.parse(instruction.dueAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThanOrEqual(13)
    expect(days).toBeLessThanOrEqual(31)
  })
})

describe('после встречи', () => {
  it('завершение встречи открывает организатору «Проверить протокол»', async () => {
    const meetingId = await createMeeting(`Оперативка ${run}`)
    const ended = await call(fx.app, {
      method: 'POST',
      url: `/meetings/${meetingId}/end`,
      as: organizer,
    })
    expect(ended.statusCode, ended.body).toBe(200)
    await drainOutbox()

    const protocol = await call(fx.app, { url: `/meetings/${meetingId}/protocol`, as: organizer })
    expect(protocol.statusCode, protocol.body).toBe(200)
    expect(protocol.json().protocol).not.toBeNull()
    const protocolId = protocol.json().protocol.id as string

    const items = await db().execute<{ kind: string; object_id: string; state: string }>(
      sql`SELECT kind, object_id, state FROM inbox_items
           WHERE user_id = ${organizer.id} AND kind = 'review_protocol'
             AND object_id = ${protocolId}`,
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.state).toBe('open')
  })
})
