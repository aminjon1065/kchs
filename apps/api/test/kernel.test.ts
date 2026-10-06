import { beforeAll, describe, expect, it } from 'vitest'
import { buildUserCtxFor } from '../src/kernel/access/explain.js'
import { activities } from '../src/kernel/activity/schema.js'
import { listActivity } from '../src/kernel/activity/service.js'
import { DelegationService } from '../src/kernel/directory/service.js'
import { LinkService } from '../src/kernel/links/service.js'
import { SettingsService } from '../src/kernel/settings/service.js'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

/** Контекст администратора — для сервиса, который зовёт обработчик маршрута. */
async function adminCtx() {
  const ctx = await buildUserCtxFor(fx.admin.id)
  if (!ctx) throw new Error('нет контекста администратора')
  return ctx
}

/** Порядок без ORDER BY не гарантирован: сравнение — по отсортированным id. */
const byId = <T extends { id: string }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id))

/** То, что вернул сервис, после JSON: ответ маршрута со схемой должен совпасть с ним (ADR-0188). */
const asJson = <T>(value: T): unknown => JSON.parse(JSON.stringify(value))

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

  it('ответ связей — всё, что вернул сервис: схема ответа ничего не теряет', async () => {
    const source = await newFolder('Связи: источник')
    const target = await newFolder('Связи: цель')
    const upstream = await newFolder('Связи: исходные данные')
    const downstream = await newFolder('Связи: потребитель')
    const linked = await call(fx.app, {
      method: 'POST',
      url: `/objects/${source}/links`,
      as: fx.admin,
      payload: { targetId: target, kind: 'related' },
    })
    expect(linked.statusCode, linked.body).toBe(200)
    await LinkService.setDependencies(db(), source, [upstream])
    await LinkService.setDependencies(db(), downstream, [source])

    const ctx = await adminCtx()
    const [links, uses, usedBy] = await Promise.all([
      LinkService.listFor(ctx, source),
      LinkService.dependenciesOf(ctx, source),
      LinkService.dependents(ctx, source),
    ])
    const response = await call(fx.app, { url: `/objects/${source}/links`, as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body.links).toHaveLength(1)
    expect(body.uses.map((item: { id: string }) => item.id)).toEqual([upstream])
    expect(body.usedBy.map((item: { id: string }) => item.id)).toEqual([downstream])
    expect({ links: byId(body.links), uses: byId(body.uses), usedBy: byId(body.usedBy) }).toEqual(
      asJson({ links: byId(links), uses: byId(uses), usedBy: byId(usedBy) }),
    )
  })
})

describe('лента активности', () => {
  it('ответ ленты — всё, что вернул сервис, и курсор следующей страницы', async () => {
    const id = await newFolder('Лента: объект')
    // Все поля записи заполнены, включая «от имени» и параметры подписи
    await db()
      .insert(activities)
      .values([
        {
          eventId: `test-activity-1-${id}`,
          objectId: id,
          spaceId: fx.spaceId,
          actorId: fx.users.member.id,
          onBehalfOf: fx.admin.id,
          verb: 'updated',
          summary: {
            key: 'activity.object.updated',
            params: { actor: 'Сотрудник', title: 'Лента: объект', fields: 'title, subtitle' },
          },
          occurredAt: '2026-10-01T08:00:00.000Z',
        },
        {
          eventId: `test-activity-2-${id}`,
          objectId: id,
          spaceId: fx.spaceId,
          actorId: fx.admin.id,
          onBehalfOf: null,
          verb: 'commented',
          summary: { key: 'activity.message.posted', params: { actor: 'Администратор', count: 2 } },
          occurredAt: '2026-10-02T08:00:00.000Z',
        },
      ])

    const first = await call(fx.app, { url: `/objects/${id}/activity?limit=1`, as: fx.admin })
    expect(first.statusCode, first.body).toBe(200)
    const page = first.json()
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(page).toEqual(asJson(await listActivity(id, { limit: 1 })))

    const rest = await call(fx.app, {
      url: `/objects/${id}/activity?limit=10&cursor=${page.nextCursor}`,
      as: fx.admin,
    })
    expect(rest.statusCode, rest.body).toBe(200)
    expect(rest.json().items.map((item: { verb: string }) => item.verb)).toContain('updated')
    expect(rest.json()).toEqual(
      asJson(await listActivity(id, { limit: 10, cursor: page.nextCursor })),
    )
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

  it('реакция: ставится и снимается, повтор не шумит, событие несёт объект обсуждения', async () => {
    const id = await newFolder('С реакциями')
    const posted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${id}/discussion/messages`,
      as: fx.admin,
      payload: { body: { type: 'doc', content: [] }, text: 'Готово' },
    })
    const messageId = posted.json().id as string
    const react = (on: boolean, as = fx.users.member) =>
      call(fx.app, {
        method: 'PUT',
        url: `/messages/${messageId}/reactions`,
        as,
        payload: { emoji: '👍', on },
      })
    const reactionsOf = async (as = fx.admin) =>
      (await call(fx.app, { url: `/objects/${id}/discussion`, as })).json().items[0].reactions

    expect((await react(true)).statusCode).toBe(200)
    expect((await react(true)).statusCode).toBe(200)
    expect(await reactionsOf()).toEqual([
      { emoji: '👍', count: 1, users: [fx.users.member.id], mine: false },
    ])
    expect((await reactionsOf(fx.users.member))[0].mine).toBe(true)

    const { sql } = await import('drizzle-orm')
    const events = await db().execute<{ object_id: string | null }>(
      sql`SELECT event->'object'->>'id' AS object_id FROM ops.outbox
           WHERE type = 'message.reacted' AND event->'payload'->>'messageId' = ${messageId}`,
    )
    // Повторная реакция ничего не меняет — события нет
    expect(events.map((row) => row.object_id)).toEqual([id])

    expect((await react(false)).statusCode).toBe(200)
    expect(await reactionsOf()).toEqual([])

    // Читатель без права писать реакцию не ставит
    expect((await react(true, fx.users.viewer)).statusCode).toBe(403)
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

  it('счётчик Входящих видит новое дело: пересчёт после коммита, а не в транзакции', async () => {
    const { InboxService } = await import('../src/kernel/inbox/service.js')
    const { systemCtx } = await import('../src/shared/context.js')
    const { listSubscribers } = await import('../src/kernel/events/bus.js')
    // Подписчики ядра регистрирует композиционный корень, а не приложение тестов
    if (listSubscribers().length === 0) {
      const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
      registerKernelSubscribers()
    }
    // Счётчик уже в кэше — как у открытого клиента
    const before = (await call(fx.app, { url: '/inbox/counts', as: fx.users.viewer })).json()
      .total as number
    const itemId = await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: fx.users.viewer.id,
        kind: 'acknowledge',
        titleKey: 'notifications.tpl.inboxAssigned',
        dedupeKey: `counts-after-commit:${Date.now()}`,
      }),
    )
    // Прежде пересчёт внутри транзакции кешировал число без нового дела на минуту
    const after = await call(fx.app, { url: '/inbox/counts', as: fx.users.viewer })
    expect(after.json().total).toBe(before + 1)

    // Подписчик события после коммита пересчитывает и отправляет верное число
    const subscriber = listSubscribers().find((item) => item.name === 'kernel-inbox-counts')
    expect(subscriber).toBeTruthy()
    await redis().del(`kchs:inbox:counts:${fx.users.viewer.id}`)
    await subscriber?.handle({
      type: 'inbox.opened',
      payload: { userId: fx.users.viewer.id, kind: 'acknowledge', itemId },
    } as never)
    const cached = JSON.parse(
      (await redis().get(`kchs:inbox:counts:${fx.users.viewer.id}`)) ?? '{}',
    )
    expect(cached.total).toBe(before + 1)
  })

  it('действия для внешних каналов — без подтверждения вторым фактором', async () => {
    const { InboxService } = await import('../src/kernel/inbox/service.js')
    const { systemCtx } = await import('../src/shared/context.js')
    const objectId = fx.spaceId
    await db().transaction((tx) =>
      InboxService.open(tx, systemCtx('test'), {
        userId: fx.users.viewer.id,
        kind: 'sign',
        objectId,
        titleKey: 'notifications.tpl.inboxAssigned',
        dedupeKey: `second-factor:${Date.now()}`,
        actions: [
          {
            key: 'sign',
            labelKey: 'inbox.actions.sign',
            variant: 'primary',
            requiresComment: false,
            requiresSecondFactor: true,
          },
          {
            key: 'refuse',
            labelKey: 'inbox.actions.refuse',
            variant: 'danger',
            requiresComment: true,
          },
        ],
      }),
    )
    const actions = await InboxService.openActions(fx.users.viewer.id, objectId)
    const keys = actions.filter((action) => action.kind === 'sign').map((action) => action.key)
    // «Подписать» с кодом — только в приложении; «Отказать» доступно и в Telegram
    expect(keys).toEqual(['refuse'])
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

  it('состояние рабочего пространства — как его прислал клиент, сервер его не разбирает', async () => {
    const save = async (state: unknown) => {
      const response = await call(fx.app, {
        method: 'PUT',
        url: '/me/workspace-state',
        as: fx.users.stranger,
        payload: { state },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const load = async () => {
      const response = await call(fx.app, { url: '/me/workspace-state', as: fx.users.stranger })
      expect(response.statusCode, response.body).toBe(200)
      return response.json()
    }

    const snapshot = {
      version: 1,
      tabs: {
        home: { id: 'home', kind: 'screen', screen: 'home', params: {}, state: { scroll: 120 } },
      },
      panes: [{ id: 'p1', tabIds: ['home'], activeTabId: 'home', linkGroup: null }],
      focusedPaneId: 'p1',
      navigatorOpen: true,
      contextOpen: false,
      contextTab: 'info',
      futureField: { 'вложенное поле': [1, 'два', null, { три: true }] },
    }
    await save(snapshot)
    expect(await load()).toEqual({ state: snapshot })
    // Не объект тоже хранится как есть: форму проверяет клиент при восстановлении
    await save(['не', 'снимок'])
    expect(await load()).toEqual({ state: ['не', 'снимок'] })
    await save(null)
    expect(await load()).toEqual({ state: null })
  })

  it('настройки интерфейса — все сохранённые значения как есть, любого вида', async () => {
    const saved: Record<string, unknown> = {
      'home.widgets': ['tasks', 'calendar', { key: 'metric', id: fx.spaceId }],
      'ui.theme': 'dark',
      'ui.density': 2,
      'ui.sidebarCollapsed': false,
      'grid.columns': { tasks: { widths: { title: 320 }, hidden: ['priority'], sort: null } },
    }
    for (const [key, value] of Object.entries(saved)) {
      const put = await call(fx.app, {
        method: 'PUT',
        url: '/me/preferences',
        as: fx.users.member,
        payload: { key, value },
      })
      expect(put.statusCode, put.body).toBe(200)
    }

    const response = await call(fx.app, { url: '/me/preferences', as: fx.users.member })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject(saved)
    expect(response.json()).toEqual(asJson(await SettingsService.forUser(fx.users.member.id)))
  })
})

describe('делегирование', () => {
  it('ответ замещений — всё, что вернул справочник: обе стороны, вид, срок и примечание', async () => {
    const create = await call(fx.app, {
      method: 'POST',
      url: '/me/delegations',
      as: fx.users.viewer,
      payload: {
        toUserId: fx.users.member.id,
        scope: 'documents',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 86_400_000).toISOString(),
        note: 'Командировка в Хорог',
      },
    })
    expect(create.statusCode, create.body).toBe(200)

    for (const user of [fx.users.viewer, fx.users.member]) {
      const response = await call(fx.app, { url: '/me/delegations', as: user })
      expect(response.statusCode, response.body).toBe(200)
      const item = response.json().items.find((row: { id: string }) => row.id === create.json().id)
      expect(item).toMatchObject({
        scope: 'documents',
        note: 'Командировка в Хорог',
        fromUser: { id: fx.users.viewer.id },
        toUser: { id: fx.users.member.id },
      })
      expect(response.json()).toEqual(asJson({ items: await DelegationService.activeFor(user.id) }))
    }

    const stop = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${create.json().id}`,
      as: fx.users.viewer,
    })
    expect(stop.statusCode, stop.body).toBe(200)
  })

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

    // Посторонний не узнаёт, что замещение есть; заместитель — получает отказ
    const stranger = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${create.json().id}`,
      as: fx.users.stranger,
    })
    expect(stranger.statusCode).toBe(404)
    const deputy = await call(fx.app, {
      method: 'DELETE',
      url: `/me/delegations/${create.json().id}`,
      as: fx.users.member,
    })
    expect(deputy.statusCode).toBe(403)

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
