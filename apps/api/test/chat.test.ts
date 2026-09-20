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
 * Мессенджер (P4-E01 S01–S04, ADR-0090): виды бесед и права на них,
 * непрочитанное и отметки прочтения, треды, закрепления, черновики, поиск,
 * присутствие и быстрые действия из сообщения.
 */
registerLifecycle()

const run = Date.now().toString(36)

let fx: TestContext
let alice: TestUser
let bob: TestUser
let outsider: TestUser

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

async function post(
  as: TestUser,
  conversationId: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    as,
    payload: {
      body: doc(text),
      text,
      attachments: [],
      mentions: [],
      mentionedObjectIds: [],
      ...extra,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

const listOf = async (as: TestUser, section = 'all'): Promise<Json> => {
  const response = await call(fx.app, { url: `/chats?section=${section}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  alice = await createUser(fx.app, `chat_a_${run}`, ['employee'])
  bob = await createUser(fx.app, `chat_b_${run}`, ['employee'])
  outsider = await createUser(fx.app, `chat_c_${run}`, ['employee'])
})

describe('личная беседа', () => {
  let conversationId = ''

  it('заводится один раз на пару и видна обоим', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: alice,
      payload: { kind: 'direct', memberIds: [bob.id] },
    })
    expect(created.statusCode, created.body).toBe(200)
    conversationId = created.json().id
    expect(created.json()).toMatchObject({ kind: 'direct', memberCount: 2 })
    // Название личной беседы — имя собеседника
    expect(created.json().peer.id).toBe(bob.id)

    // Повторный запрос возвращает ту же беседу — детерминированный ключ пары
    const again = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: bob,
      payload: { kind: 'direct', memberIds: [alice.id] },
    })
    expect(again.json().id).toBe(conversationId)
    expect(again.json().peer.id).toBe(alice.id)
  })

  it('посторонний беседы не видит и не пишет в неё', async () => {
    const asOutsider = await call(fx.app, { url: `/chats/${conversationId}`, as: outsider })
    expect(asOutsider.statusCode).toBe(404)

    const write = await call(fx.app, {
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      as: outsider,
      payload: {
        body: doc('подслушиваю'),
        text: 'подслушиваю',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(write.statusCode).toBe(404)

    const list = await listOf(outsider)
    expect(list.items.some((item: Json) => item.id === conversationId)).toBe(false)
  })

  it('непрочитанное считается до отметки прочтения', async () => {
    const first = await post(alice, conversationId, `Привет ${run}`)
    await post(alice, conversationId, 'Есть минутка?')

    const forBob = await listOf(bob)
    const item = forBob.items.find((row: Json) => row.id === conversationId)
    expect(item.unreadCount).toBe(2)
    expect(item.firstUnreadMessageId).toBe(first)
    expect(forBob.totalUnread).toBeGreaterThanOrEqual(2)

    // Свои сообщения непрочитанными не считаются
    const forAlice = await listOf(alice)
    expect(forAlice.items.find((row: Json) => row.id === conversationId).unreadCount).toBe(0)

    const last = await post(alice, conversationId, 'Последнее')
    const read = await call(fx.app, {
      method: 'POST',
      url: `/conversations/${conversationId}/read`,
      as: bob,
      payload: { messageId: last },
    })
    expect(read.statusCode, read.body).toBe(200)
    const after = await listOf(bob)
    expect(after.items.find((row: Json) => row.id === conversationId).unreadCount).toBe(0)
  })

  it('тред и закрепление сообщения', async () => {
    const root = await post(alice, conversationId, 'Корень треда')
    await post(bob, conversationId, 'Ответ в треде', { threadRootId: root })

    const thread = await call(fx.app, {
      url: `/conversations/${conversationId}/messages?threadRootId=${root}`,
      as: alice,
    })
    expect(thread.statusCode, thread.body).toBe(200)
    expect(thread.json().items).toHaveLength(1)
    expect(thread.json().items[0].text).toBe('Ответ в треде')

    // В ленте ответ треда не дублируется
    const feed = await call(fx.app, { url: `/conversations/${conversationId}/messages`, as: alice })
    expect(feed.json().items.some((m: Json) => m.text === 'Ответ в треде')).toBe(false)
    expect(feed.json().items.some((m: Json) => m.id === root)).toBe(true)

    const pinned = await call(fx.app, {
      method: 'PUT',
      url: `/chats/${conversationId}/pins`,
      as: bob,
      payload: { messageId: root, on: true },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json().items[0]).toMatchObject({ messageId: root, text: 'Корень треда' })

    const unpinned = await call(fx.app, {
      method: 'PUT',
      url: `/chats/${conversationId}/pins`,
      as: bob,
      payload: { messageId: root, on: false },
    })
    expect(unpinned.json().items).toHaveLength(0)
  })

  it('черновик сохраняется и возвращается владельцу', async () => {
    const saved = await call(fx.app, {
      method: 'PUT',
      url: `/chats/${conversationId}/draft`,
      as: alice,
      payload: { threadRootId: null, body: doc('не дописал'), text: 'не дописал' },
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const mine = await call(fx.app, { url: '/chats/drafts', as: alice })
    expect(mine.json().items).toHaveLength(1)
    expect(mine.json().items[0]).toMatchObject({ conversationId, text: 'не дописал' })

    const foreign = await call(fx.app, { url: '/chats/drafts', as: bob })
    expect(foreign.json().items).toHaveLength(0)

    // Пустой черновик удаляется
    await call(fx.app, {
      method: 'PUT',
      url: `/chats/${conversationId}/draft`,
      as: alice,
      payload: { threadRootId: null, body: null, text: '' },
    })
    expect((await call(fx.app, { url: '/chats/drafts', as: alice })).json().items).toHaveLength(0)
  })

  it('поиск по беседе находит сообщение, посторонний — нет', async () => {
    const found = await call(fx.app, {
      url: `/chats/search?q=${encodeURIComponent(`Привет ${run}`)}&conversationId=${conversationId}`,
      as: bob,
    })
    expect(found.statusCode, found.body).toBe(200)
    expect(found.json().hits.length).toBeGreaterThan(0)
    expect(found.json().hits[0].snippet).toContain('<mark>')

    const denied = await call(fx.app, {
      url: `/chats/search?q=${encodeURIComponent(run)}&conversationId=${conversationId}`,
      as: outsider,
    })
    expect(denied.statusCode).toBe(404)
  })
})

describe('каналы и группы', () => {
  let openChannelId = ''
  let closedChannelId = ''

  it('открытый канал пространства виден и принимает вступление', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: fx.admin,
      payload: {
        kind: 'channel',
        title: `Дежурная смена ${run}`,
        privacy: 'open',
        spaceId: fx.spaceId,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    openChannelId = created.json().id

    // Участник пространства видит канал в разделе «куда вступить»
    const discover = await listOf(fx.users.member, 'discover')
    const offered = discover.items.find((row: Json) => row.id === openChannelId)
    expect(offered).toBeTruthy()
    expect(offered.can.join).toBe(true)
    expect(offered.member).toBe(false)

    const joined = await call(fx.app, {
      method: 'POST',
      url: `/chats/${openChannelId}/join`,
      as: fx.users.member,
    })
    expect(joined.statusCode, joined.body).toBe(200)
    expect(joined.json()).toMatchObject({ member: true, memberCount: 2 })

    await post(fx.users.member, openChannelId, `Заступил ${run}`)

    // Тот, кто не в пространстве, канала не видит
    const stranger = await call(fx.app, { url: `/chats/${openChannelId}`, as: outsider })
    expect(stranger.statusCode).toBe(404)
  })

  it('закрытый канал виден только приглашённым', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: fx.admin,
      payload: {
        kind: 'channel',
        title: `Штаб ${run}`,
        privacy: 'closed',
        spaceId: fx.spaceId,
        memberIds: [alice.id],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    closedChannelId = created.json().id

    const asMember = await call(fx.app, { url: `/chats/${closedChannelId}`, as: alice })
    expect(asMember.statusCode).toBe(200)

    // Участник пространства без приглашения закрытого канала не видит
    const asSpaceMember = await call(fx.app, {
      url: `/chats/${closedChannelId}`,
      as: fx.users.member,
    })
    expect(asSpaceMember.statusCode).toBe(404)

    const join = await call(fx.app, {
      method: 'POST',
      url: `/chats/${closedChannelId}/join`,
      as: fx.users.member,
    })
    expect(join.statusCode).toBe(404)
  })

  it('приглашение, переименование и выход', async () => {
    const invited = await call(fx.app, {
      method: 'POST',
      url: `/chats/${closedChannelId}/invite`,
      as: fx.admin,
      payload: { userIds: [bob.id] },
    })
    expect(invited.statusCode, invited.body).toBe(200)
    expect(invited.json().added).toEqual([bob.id])
    expect((await call(fx.app, { url: `/chats/${closedChannelId}`, as: bob })).statusCode).toBe(200)

    // Приглашать может только владелец беседы
    const byMember = await call(fx.app, {
      method: 'POST',
      url: `/chats/${closedChannelId}/invite`,
      as: alice,
      payload: { userIds: [outsider.id] },
    })
    expect(byMember.statusCode).toBe(403)

    const renamedByMember = await call(fx.app, {
      method: 'PATCH',
      url: `/chats/${closedChannelId}`,
      as: alice,
      payload: { title: 'Моё' },
    })
    expect(renamedByMember.statusCode).toBe(403)

    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/chats/${closedChannelId}`,
      as: fx.admin,
      payload: { title: `Оперативный штаб ${run}` },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)
    expect(renamed.json().title).toBe(`Оперативный штаб ${run}`)

    const left = await call(fx.app, {
      method: 'POST',
      url: `/chats/${closedChannelId}/leave`,
      as: bob,
    })
    expect(left.statusCode, left.body).toBe(200)
    expect((await call(fx.app, { url: `/chats/${closedChannelId}`, as: bob })).statusCode).toBe(404)
  })

  it('закрепление и «без звука» — настройка участника', async () => {
    const pinned = await call(fx.app, {
      method: 'PUT',
      url: `/chats/${openChannelId}/settings`,
      as: fx.users.member,
      payload: { pinned: true, muted: true },
    })
    expect(pinned.statusCode, pinned.body).toBe(200)
    expect(pinned.json()).toMatchObject({ pinned: true, muted: true })

    const forOwner = await listOf(fx.admin)
    expect(forOwner.items.find((row: Json) => row.id === openChannelId).pinned).toBe(false)
  })
})

describe('обсуждение объекта в списке бесед', () => {
  it('появляется у того, кто в нём участвует, и скрыто от остальных', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Паводок ${run}`, spaceId: fx.spaceId },
    })
    expect(folder.statusCode, folder.body).toBe(200)
    const objectId = folder.json().id

    const message = await call(fx.app, {
      method: 'POST',
      url: `/objects/${objectId}/discussion/messages`,
      as: fx.admin,
      payload: {
        body: doc(`Обсуждаем ${run}`),
        text: `Обсуждаем ${run}`,
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(message.statusCode, message.body).toBe(200)
    const conversationId = message.json().conversationId

    const mine = await listOf(fx.admin, 'discussions')
    const item = mine.items.find((row: Json) => row.id === conversationId)
    expect(item).toBeTruthy()
    expect(item.objectId).toBe(objectId)
    expect(item.can.leave).toBe(false)

    // Не участник обсуждения его в списке не видит
    const other = await listOf(fx.users.member, 'discussions')
    expect(other.items.some((row: Json) => row.id === conversationId)).toBe(false)
  })
})

describe('быстрые действия из сообщения', () => {
  let conversationId = ''
  let messageId = ''

  it('поручение с цитатой и связью с источником', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: alice,
      payload: { kind: 'group', title: `Разбор ${run}`, memberIds: [bob.id] },
    })
    expect(created.statusCode, created.body).toBe(200)
    conversationId = created.json().id
    messageId = await post(alice, conversationId, `Нужно проверить насос ${run}`)

    const task = await call(fx.app, {
      method: 'POST',
      url: `/chats/messages/${messageId}/task`,
      as: alice,
      payload: { title: `Проверить насос ${run}`, assigneeId: bob.id, dueWorkingDays: 2 },
    })
    expect(task.statusCode, task.body).toBe(200)
    const { taskId, key } = task.json()
    expect(key).toBeTruthy()

    const card = await call(fx.app, { url: `/tasks/${taskId}`, as: bob })
    expect(card.statusCode, card.body).toBe(200)
    expect(card.json().description).toContain(`насос ${run}`)

    // Связь с источником: беседа знает о поручении
    const links = await db().execute<{ kind: string; source_id: string; target_id: string }>(
      sql`SELECT kind, source_id, target_id FROM links
           WHERE source_id = ${conversationId}::uuid OR target_id = ${conversationId}::uuid`,
    )
    expect(
      links.some(
        (link) =>
          link.kind === 'source' && (link.target_id === taskId || link.source_id === taskId),
      ),
    ).toBe(true)

    // В ленте остался след с цитатой
    const feed = await call(fx.app, { url: `/conversations/${conversationId}/messages`, as: bob })
    expect(feed.json().items.some((m: Json) => m.kind === 'action')).toBe(true)
  })

  it('пересылка сообщения в другую беседу', async () => {
    const target = await call(fx.app, {
      method: 'POST',
      url: '/chats',
      as: alice,
      payload: { kind: 'direct', memberIds: [bob.id] },
    })
    const targetId = target.json().id

    const forwarded = await call(fx.app, {
      method: 'POST',
      url: '/chats/forward',
      as: alice,
      payload: { messageIds: [messageId], toConversationIds: [targetId] },
    })
    expect(forwarded.statusCode, forwarded.body).toBe(200)
    expect(forwarded.json().posted).toBe(1)

    const feed = await call(fx.app, { url: `/conversations/${targetId}/messages`, as: bob })
    expect(feed.json().items.some((m: Json) => m.text.includes(`насос ${run}`))).toBe(true)

    // Переслать в беседу, где нет прав, нельзя
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/chats/forward',
      as: outsider,
      payload: { messageIds: [messageId], toConversationIds: [targetId] },
    })
    expect(denied.statusCode).toBe(404)
  })

  it('прикрепление сообщения к объекту требует права на объект', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Дело ${run}`, spaceId: fx.spaceId },
    })
    const objectId = folder.json().id

    const denied = await call(fx.app, {
      method: 'POST',
      url: `/chats/messages/${messageId}/attach`,
      as: alice,
      payload: { objectId },
    })
    expect(denied.statusCode).toBe(404)

    const attached = await call(fx.app, {
      method: 'POST',
      url: `/chats/messages/${messageId}/attach`,
      as: fx.admin,
      payload: { objectId },
    })
    // Администратор системы видит объект и беседу: связь заводится
    expect(attached.statusCode, attached.body).toBe(200)
  })

  it('звонок из беседы без медиасервера всё равно заводит встречу', async () => {
    const started = await call(fx.app, {
      method: 'POST',
      url: `/chats/${conversationId}/call`,
      as: alice,
      payload: {},
    })
    expect(started.statusCode, started.body).toBe(200)
    const meeting = await call(fx.app, {
      url: `/meetings/${started.json().meetingId}`,
      as: bob,
    })
    expect(meeting.statusCode, meeting.body).toBe(200)
    expect(meeting.json()).toMatchObject({ kind: 'call', conversationId })
  })
})

describe('присутствие и статусы', () => {
  it('«не беспокоить» держится до срока, тихие часы сохраняются', async () => {
    const before = await call(fx.app, { url: '/me/presence', as: alice })
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json().chosen).toBe('online')

    const updated = await call(fx.app, {
      method: 'PUT',
      url: '/me/presence',
      as: alice,
      payload: { status: 'dnd', untilMinutes: 60, quietHours: { enabled: true, from: '22:00', to: '07:00' } },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({ status: 'dnd', chosen: 'dnd' })
    expect(updated.json().quietHours).toMatchObject({ enabled: true, from: '22:00' })
    expect(updated.json().until).toBeTruthy()

    const seen = await call(fx.app, { url: `/presence?userIds=${alice.id}`, as: bob })
    expect(seen.statusCode, seen.body).toBe(200)
    expect(seen.json().items[0]).toMatchObject({ userId: alice.id, status: 'dnd' })

    const back = await call(fx.app, {
      method: 'PUT',
      url: '/me/presence',
      as: alice,
      payload: { status: 'online' },
    })
    expect(back.json().status).toBe('online')
  })
})
