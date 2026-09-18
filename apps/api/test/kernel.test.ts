import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

async function newFolder(name: string, parentId?: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId, ...(parentId ? { parentId } : {}) },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id
}

describe('реестр объектов', () => {
  it('создание объекта пишет событие в outbox в той же транзакции', async () => {
    const id = await newFolder('Событие')
    const rows = await db().execute<{ count: string }>(
      // eslint-disable-next-line no-template-curly-in-string
      (await import('drizzle-orm')).sql`
        SELECT count(*)::text AS count FROM ops.outbox
         WHERE event->'object'->>'id' = ${id} AND type = 'object.created'`,
    )
    expect(Number(rows[0]?.count ?? 0)).toBe(1)
  })

  it('перенос пересчитывает предков', async () => {
    const a = await newFolder('А')
    const b = await newFolder('Б')
    const child = await newFolder('Вложенная', a)

    const before = await call(fx.app, { url: `/objects/${child}`, as: fx.admin })
    expect(before.json().breadcrumbs.map((c: { id: string }) => c.id)).toEqual([a])

    const move = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${child}`,
      as: fx.admin,
      payload: { parentId: b },
    })
    expect(move.statusCode).toBe(200)

    const after = await call(fx.app, { url: `/objects/${child}`, as: fx.admin })
    expect(after.json().breadcrumbs.map((c: { id: string }) => c.id)).toEqual([b])
  })

  it('нельзя перенести объект в собственную ветку', async () => {
    const parent = await newFolder('Родитель')
    const child = await newFolder('Потомок', parent)
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${parent}`,
      as: fx.admin,
      payload: { parentId: child },
    })
    expect(response.statusCode).toBe(400)
  })

  it('корзина и восстановление затрагивают поддерево', async () => {
    const parent = await newFolder('В корзину')
    const child = await newFolder('Ребёнок', parent)

    expect(
      (await call(fx.app, { method: 'DELETE', url: `/objects/${parent}`, as: fx.admin }))
        .statusCode,
    ).toBe(200)
    expect((await call(fx.app, { url: `/objects/${child}`, as: fx.admin })).statusCode).toBe(404)

    expect(
      (await call(fx.app, { method: 'POST', url: `/objects/${parent}/restore`, as: fx.admin }))
        .statusCode,
    ).toBe(200)
    expect((await call(fx.app, { url: `/objects/${child}`, as: fx.admin })).statusCode).toBe(200)
  })

  it('оптимистичная блокировка по версии', async () => {
    const id = await newFolder('Версии')
    const card = await call(fx.app, { url: `/objects/${id}`, as: fx.admin })
    const version = card.json().version

    const ok = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${id}`,
      as: fx.admin,
      payload: { title: 'Новое имя' },
      headers: { 'if-match': String(version) },
    })
    expect(ok.statusCode).toBe(200)

    const stale = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${id}`,
      as: fx.admin,
      payload: { title: 'Ещё имя' },
      headers: { 'if-match': String(version) },
    })
    expect(stale.statusCode).toBe(412)
  })

  it('избранное и недавние', async () => {
    const id = await newFolder('Избранная')
    await call(fx.app, { method: 'PUT', url: `/objects/${id}/favorite`, as: fx.admin })
    const favorites = await call(fx.app, { url: '/me/favorites', as: fx.admin })
    expect(favorites.json().items.map((i: { id: string }) => i.id)).toContain(id)

    await call(fx.app, { url: `/objects/${id}`, as: fx.admin })
    const recent = await call(fx.app, { url: '/me/recent', as: fx.admin })
    expect(recent.json().items.map((i: { id: string }) => i.id)).toContain(id)
  })
})

describe('связи', () => {
  it('связь двунаправленная по чтению', async () => {
    const a = await newFolder('Источник')
    const b = await newFolder('Цель')
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${a}/links`,
      as: fx.admin,
      payload: { targetId: b, kind: 'related' },
    })

    const fromA = await call(fx.app, { url: `/objects/${a}/links`, as: fx.admin })
    expect(fromA.json().links[0].direction).toBe('outgoing')
    const fromB = await call(fx.app, { url: `/objects/${b}/links`, as: fx.admin })
    expect(fromB.json().links[0].direction).toBe('incoming')
  })
})

describe('обсуждения', () => {
  it('сообщение, упоминание и лента активности', async () => {
    const id = await newFolder('Обсуждаемая')
    const post = await call(fx.app, {
      method: 'POST',
      url: `/objects/${id}/discussion/messages`,
      as: fx.admin,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Проверьте, пожалуйста',
        attachments: [],
        mentions: [fx.users.member.id],
        mentionedObjectIds: [],
      },
    })
    expect(post.statusCode).toBe(200)

    const discussion = await call(fx.app, { url: `/objects/${id}/discussion`, as: fx.admin })
    expect(discussion.json().items).toHaveLength(1)
    expect(discussion.json().items[0].text).toBe('Проверьте, пожалуйста')
    expect(discussion.json().items[0].mentions).toContain(fx.users.member.id)
  })

  it('уровень view не даёт писать в обсуждение', async () => {
    const id = await newFolder('Только чтение')
    const response = await call(fx.app, {
      method: 'POST',
      url: `/objects/${id}/discussion/messages`,
      as: fx.users.viewer,
      payload: {
        body: { type: 'doc', content: [] },
        text: 'Нельзя',
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('пространства', () => {
  it('участники и смена роли', async () => {
    const members = await call(fx.app, { url: `/spaces/${fx.spaceId}/members`, as: fx.admin })
    expect(members.json().items.length).toBeGreaterThanOrEqual(3)

    const change = await call(fx.app, {
      method: 'PUT',
      url: `/spaces/${fx.spaceId}/members/${fx.users.viewer.id}`,
      as: fx.admin,
      payload: { role: 'member' },
    })
    expect(change.statusCode).toBe(200)
  })

  it('последнего администратора нельзя исключить, разжаловать или пригласить заново ниже', async () => {
    const space = await call(fx.app, {
      method: 'POST',
      url: '/spaces',
      as: fx.admin,
      payload: { key: `adm-${Date.now().toString().slice(-8)}`, name: 'Без администратора?' },
    })
    expect(space.statusCode).toBe(200)
    const spaceId = space.json().id as string
    const adminId = fx.admin.id
    const members = `/spaces/${spaceId}/members`

    const attempts = [
      { method: 'DELETE' as const, url: `${members}/${adminId}` },
      { method: 'PUT' as const, url: `${members}/${adminId}`, payload: { role: 'editor' } },
      { method: 'POST' as const, url: members, payload: { userId: adminId, role: 'member' } },
    ]
    for (const attempt of attempts) {
      const response = await call(fx.app, { ...attempt, as: fx.admin })
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(409)
    }

    // Со вторым администратором первый может уйти
    const second = await call(fx.app, {
      method: 'POST',
      url: members,
      as: fx.admin,
      payload: { userId: fx.users.member.id, role: 'admin' },
    })
    expect(second.statusCode).toBe(200)
    const leave = await call(fx.app, {
      method: 'DELETE',
      url: `${members}/${adminId}`,
      as: fx.admin,
    })
    expect(leave.statusCode).toBe(200)
    const left = await call(fx.app, { url: members, as: fx.users.member })
    expect(left.json().items.map((m: { userId: string }) => m.userId)).toEqual([fx.users.member.id])
  })

  it('личное пространство создаётся вместе с пользователем', async () => {
    const me = await call(fx.app, { url: '/me', as: fx.users.member })
    expect(me.json().personalSpaceId).toBeTruthy()
  })
})

describe('Входящие и уведомления', () => {
  it('счётчики доступны и пусты в начале', async () => {
    const counts = await call(fx.app, { url: '/inbox/counts', as: fx.users.member })
    expect(counts.statusCode).toBe(200)
    expect(counts.json().total).toBe(0)
  })

  it('центр уведомлений отвечает', async () => {
    const response = await call(fx.app, { url: '/notifications', as: fx.users.member })
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(response.json().items)).toBe(true)
  })
})

describe('профиль и сессии', () => {
  it('смена профиля и локали', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: '/me',
      as: fx.users.member,
      payload: { locale: 'tg', timezone: 'Asia/Dushanbe' },
    })
    expect(response.statusCode).toBe(200)
    const me = await call(fx.app, { url: '/me', as: fx.users.member })
    expect(me.json().user.locale).toBe('tg')
  })

  it('список сессий содержит текущую', async () => {
    const response = await call(fx.app, { url: '/me/sessions', as: fx.users.member })
    expect(response.json().items.some((s: { current: boolean }) => s.current)).toBe(true)
  })

  it('состояние рабочего пространства сохраняется', async () => {
    const state = { tabs: [{ id: 'home', title: 'Мой день' }], activeTabId: 'home' }
    const save = await call(fx.app, {
      method: 'PUT',
      url: '/me/workspace-state',
      as: fx.users.member,
      payload: { state },
    })
    expect(save.statusCode).toBe(200)

    const load = await call(fx.app, { url: '/me/workspace-state', as: fx.users.member })
    expect(load.json().state).toEqual(state)
  })
})

describe('делегирование', () => {
  it('замещение видно обеим сторонам', async () => {
    const create = await call(fx.app, {
      method: 'POST',
      url: '/me/delegations',
      as: fx.admin,
      payload: {
        toUserId: fx.users.member.id,
        scope: 'all',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        note: 'Отпуск',
      },
    })
    expect(create.statusCode).toBe(200)

    const mine = await call(fx.app, { url: '/me/delegations', as: fx.admin })
    expect(mine.json().items).toHaveLength(1)

    const theirs = await call(fx.app, { url: '/me/delegations', as: fx.users.member })
    expect(theirs.json().items).toHaveLength(1)

    const stop = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${create.json().id}`,
      as: fx.admin,
    })
    expect(stop.statusCode).toBe(200)
  })
})

describe('присутствие', () => {
  it('кто смотрит объект: отметка, уход, отметка без подтверждения устаревает', async () => {
    const { markLeft, markViewing, viewers, PRESENCE_TTL_MS } = await import(
      '../src/kernel/realtime/presence.js'
    )
    const { cacheKeys } = await import('../src/shared/redis/index.js')
    const objectId = crypto.randomUUID()
    const t0 = Date.now()
    await markViewing(objectId, { id: 'anna', displayName: 'Анна' }, t0)
    const both = await markViewing(objectId, { id: 'bahrom', displayName: 'Бахром' }, t0 + 1000)
    expect(both.map((viewer) => viewer.id).sort()).toEqual(['anna', 'bahrom'])

    // Анна ушла — соседи видят сразу
    const left = await markLeft(objectId, 'anna', t0 + 2000)
    expect(left.map((viewer) => viewer.id)).toEqual(['bahrom'])

    // Бахром закрыл вкладку без прощания: после срока его нет, отметка удалена
    expect(await viewers(objectId, t0 + 1000 + PRESENCE_TTL_MS + 1)).toEqual([])
    expect(await redis().hlen(cacheKeys.presence(objectId))).toBe(0)
  })
})
