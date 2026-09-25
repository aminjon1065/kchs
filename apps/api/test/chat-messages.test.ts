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
 * Доработка чатов до пилота (ADR-0161): правка и удаление в срок, ведущий
 * беседы, отметки прочтения только вперёд с событием `message.read`, архив
 * у каждого участника свой, пересылка без удалённых.
 */
registerLifecycle()

const run = Date.now().toString(36)

let fx: TestContext
let alice: TestUser
let bob: TestUser
let carol: TestUser

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

async function post(as: TestUser, conversationId: string, text: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    as,
    payload: { body: doc(text), text, attachments: [], mentions: [], mentionedObjectIds: [] },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

async function feed(as: TestUser, conversationId: string): Promise<Json[]> {
  const response = await call(fx.app, { url: `/conversations/${conversationId}/messages`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

async function chat(as: TestUser, kind: 'direct' | 'group', memberIds: string[]): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/chats',
    as,
    payload: { kind, memberIds, ...(kind === 'group' ? { title: `Штаб ${run}` } : {}) },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

/** Сообщение «отправлено» раньше — чтобы проверить срок правки без ожидания. */
async function age(messageId: string, hours: number): Promise<void> {
  await db().execute(
    sql`UPDATE messages SET created_at = now() - make_interval(hours => ${hours})
         WHERE id = ${Number(messageId)}`,
  )
}

const edit = (as: TestUser, messageId: string, text: string) =>
  call(fx.app, {
    method: 'PATCH',
    url: `/messages/${messageId}`,
    as,
    payload: { body: doc(text), text, mentions: [], mentionedObjectIds: [] },
  })

const remove = (as: TestUser, messageId: string) =>
  call(fx.app, { method: 'DELETE', url: `/messages/${messageId}`, as })

const settings = (as: TestUser, conversationId: string, patch: Record<string, boolean>) =>
  call(fx.app, { method: 'PUT', url: `/chats/${conversationId}/settings`, as, payload: patch })

const section = async (as: TestUser, name: string): Promise<Json> => {
  const response = await call(fx.app, { url: `/chats?section=${name}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  alice = await createUser(fx.app, `chm_a_${run}`, ['employee'])
  bob = await createUser(fx.app, `chm_b_${run}`, ['employee'])
  carol = await createUser(fx.app, `chm_c_${run}`, ['employee'])
})

describe('правка и удаление', () => {
  let direct = ''

  beforeAll(async () => {
    direct = await chat(alice, 'direct', [bob.id])
  })

  it('автор правит своё в срок: пометка «изменено», право видно только ему', async () => {
    const id = await post(alice, direct, `Сбор в 9:00 ${run}`)
    expect((await edit(alice, id, `Сбор в 10:00 ${run}`)).statusCode).toBe(200)

    const mine = (await feed(alice, direct)).find((m: Json) => m.id === id)
    expect(mine.text).toBe(`Сбор в 10:00 ${run}`)
    expect(mine.editedAt).not.toBeNull()
    expect(mine.can).toEqual({ edit: true, delete: true })

    const theirs = (await feed(bob, direct)).find((m: Json) => m.id === id)
    expect(theirs.can).toEqual({ edit: false, delete: false })
    expect((await edit(bob, id, 'чужое')).statusCode).toBe(403)
  })

  it('после срока правка и удаление автором закрыты', async () => {
    const id = await post(alice, direct, `Старое ${run}`)
    await age(id, 25)
    const row = (await feed(alice, direct)).find((m: Json) => m.id === id)
    expect(row.can).toEqual({ edit: false, delete: false })
    const edited = await edit(alice, id, 'поздно')
    expect(edited.statusCode).toBe(403)
    expect(edited.body).toContain('24')
    expect((await remove(alice, id)).statusCode).toBe(403)
  })

  it('удалённое остаётся строкой без текста, вложений и реакций', async () => {
    const id = await post(alice, direct, `Ошибся беседой ${run}`)
    const reacted = await call(fx.app, {
      method: 'PUT',
      url: `/messages/${id}/reactions`,
      as: bob,
      payload: { emoji: '👀', on: true },
    })
    expect(reacted.statusCode, reacted.body).toBe(200)

    expect((await remove(alice, id)).statusCode).toBe(200)
    const row = (await feed(bob, direct)).find((m: Json) => m.id === id)
    expect(row.deletedAt).not.toBeNull()
    expect(row.text).toBe('')
    expect(row.body).toBeNull()
    expect(row.reactions).toEqual([])
    expect(row.can).toEqual({ edit: false, delete: false })

    // Повторно не удаляется и не правится; в личной беседе ведущих нет
    expect((await remove(alice, id)).statusCode).toBe(404)
    expect((await edit(alice, id, 'вернуть')).statusCode).toBe(404)
    const other = await post(bob, direct, `Ответ ${run}`)
    expect((await remove(alice, other)).statusCode).toBe(403)
  })

  it('владелец группы удаляет чужое в любой срок, участник — нет', async () => {
    const group = await chat(alice, 'group', [bob.id, carol.id])
    const id = await post(bob, group, `Неуместное ${run}`)
    await age(id, 72)

    const forOwner = (await feed(alice, group)).find((m: Json) => m.id === id)
    expect(forOwner.can.delete).toBe(true)
    expect((await remove(carol, id)).statusCode).toBe(403)
    expect((await remove(alice, id)).statusCode).toBe(200)
  })

  it('удалённое сообщение не пересылается', async () => {
    const gone = await post(alice, direct, `Удалю ${run}`)
    const kept = await post(alice, direct, `Перешлю ${run}`)
    expect((await remove(alice, gone)).statusCode).toBe(200)
    const group = await chat(alice, 'group', [carol.id])

    const onlyGone = await call(fx.app, {
      method: 'POST',
      url: '/chats/forward',
      as: alice,
      payload: { messageIds: [gone], toConversationIds: [group] },
    })
    expect(onlyGone.statusCode).toBe(404)

    const both = await call(fx.app, {
      method: 'POST',
      url: '/chats/forward',
      as: alice,
      payload: { messageIds: [gone, kept], toConversationIds: [group] },
    })
    expect(both.statusCode, both.body).toBe(200)
    expect(both.json().posted).toBe(1)
  })
})

describe('прочтение', () => {
  it('отметка только вперёд, событие — на каждое продвижение', async () => {
    const group = await chat(alice, 'group', [bob.id, carol.id])
    const first = await post(alice, group, `Первое ${run}`)
    const second = await post(alice, group, `Второе ${run}`)

    const read = (as: TestUser, messageId: string) =>
      call(fx.app, {
        method: 'POST',
        url: `/conversations/${group}/read`,
        as,
        payload: { messageId },
      })
    expect((await read(bob, second)).statusCode).toBe(200)
    expect((await read(bob, first)).statusCode).toBe(200)
    expect((await read(bob, second)).statusCode).toBe(200)

    const members = await call(fx.app, { url: `/chats/${group}/members`, as: alice })
    expect(members.statusCode, members.body).toBe(200)
    const byUser = new Map<string, Json>(
      members.json().items.map((m: Json) => [m.user.id, m.lastReadMessageId]),
    )
    expect(byUser.get(bob.id)).toBe(second)
    expect(byUser.get(carol.id)).toBeNull()

    const events = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ops.outbox
           WHERE type = 'message.read'
             AND event->'payload'->>'conversationId' = ${group}
             AND event->'payload'->>'userId' = ${bob.id}`,
    )
    expect(events[0]?.n).toBe(1)
  })
})

describe('архив', () => {
  it('у каждого свой; новое сообщение возвращает беседу, если звук включён', async () => {
    const direct = await chat(bob, 'direct', [carol.id])
    await post(carol, direct, `Привет ${run}`)

    expect((await settings(bob, direct, { pinned: true })).statusCode).toBe(200)
    expect((await settings(bob, direct, { archived: true })).statusCode).toBe(200)

    const all = await section(bob, 'all')
    expect(all.items.some((item: Json) => item.id === direct)).toBe(false)
    const archived = await section(bob, 'archived')
    const item = archived.items.find((i: Json) => i.id === direct)
    expect(item?.archived).toBe(true)
    // В архиве беседа не закреплена, её непрочитанное не в общем счётчике
    expect(item?.pinned).toBe(false)
    expect(item?.unreadCount).toBe(1)
    expect(archived.totalUnread).toBe(all.totalUnread)

    // У собеседника беседа на месте
    const carolAll = await section(carol, 'all')
    expect(carolAll.items.some((i: Json) => i.id === direct)).toBe(true)

    await post(carol, direct, `Срочно ${run}`)
    const back = await section(bob, 'all')
    expect(back.items.find((i: Json) => i.id === direct)?.archived).toBe(false)
  })

  it('беседа без звука остаётся в архиве и с новыми сообщениями; вернуть — вручную', async () => {
    const direct = await chat(carol, 'direct', [alice.id])
    await post(alice, direct, `Рассылка ${run}`)
    expect((await settings(carol, direct, { muted: true, archived: true })).statusCode).toBe(200)

    await post(alice, direct, `Ещё рассылка ${run}`)
    const archived = await section(carol, 'archived')
    expect(archived.items.some((i: Json) => i.id === direct)).toBe(true)

    expect((await settings(carol, direct, { archived: false })).statusCode).toBe(200)
    const all = await section(carol, 'all')
    expect(all.items.find((i: Json) => i.id === direct)?.archived).toBe(false)
  })
})
