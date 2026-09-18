import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  signIn,
  type TestContext,
} from './helpers.js'

/**
 * Обязательные негативные тесты доступа (04-verification.md §2).
 * Проверяются все пути: список, прямой GET, поиск, связи, действия.
 */
registerLifecycle()

let fx: TestContext
let folderId: string
let restrictedId: string

beforeAll(async () => {
  fx = await setupFixture()

  const folder = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name: 'Общая папка', spaceId: fx.spaceId },
  })
  expect(folder.statusCode).toBe(200)
  folderId = folder.json().id

  const restricted = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name: 'Закрытая папка', spaceId: fx.spaceId },
  })
  restrictedId = restricted.json().id
  const mode = await call(fx.app, {
    method: 'PUT',
    url: `/objects/${restrictedId}/access-mode`,
    as: fx.admin,
    payload: { mode: 'restricted' },
  })
  expect(mode.statusCode).toBe(200)
})

describe('уровни доступа', () => {
  it('владелец получает owner', async () => {
    const response = await call(fx.app, { url: `/objects/${folderId}`, as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(response.json().level).toBe('owner')
  })

  it('участник пространства editor получает edit', async () => {
    const response = await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.member })
    expect(response.statusCode).toBe(200)
    expect(response.json().level).toBe('edit')
  })

  it('участник пространства viewer получает view', async () => {
    const response = await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.viewer })
    expect(response.json().level).toBe('view')
  })

  it('посторонний не видит объект — 404, а не 403', async () => {
    const response = await call(fx.app, { url: `/objects/${folderId}`, as: fx.users.stranger })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('not_found')
  })

  it('без сессии — 401', async () => {
    const response = await call(fx.app, { url: `/objects/${folderId}` })
    expect(response.statusCode).toBe(401)
  })
})

describe('разрыв наследования', () => {
  it('объект переходит в режим restricted', async () => {
    const response = await call(fx.app, { url: `/objects/${restrictedId}`, as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(response.json().accessMode).toBe('restricted')
  })

  it('текущие права копируются явно — ничего не исчезает', async () => {
    // 03-access-model.md §Наследование: при разрыве эффективные записи
    // копируются явно, поэтому участник пространства сохраняет доступ…
    const response = await call(fx.app, { url: `/objects/${restrictedId}`, as: fx.users.member })
    expect(response.statusCode).toBe(200)

    const access = await call(fx.app, { url: `/objects/${restrictedId}/access`, as: fx.admin })
    const entry = access
      .json()
      .entries.find((e: { principal: { id: string } }) => e.principal.id === fx.users.member.id)
    expect(entry).toBeDefined()
    // …но уже как явная запись, а не как роль в пространстве
    expect(entry.reasons.map((r: { kind: string }) => r.kind)).toContain('explicit')
  })

  it('новый участник пространства доступа к restricted не получает', async () => {
    const newcomer = await createUser(fx.app, 'newcomer_test')
    await call(fx.app, {
      method: 'POST',
      url: `/spaces/${fx.spaceId}/members`,
      as: fx.admin,
      payload: { userId: newcomer.id, role: 'editor' },
    })
    const fresh = await signIn(fx.app, newcomer.login, newcomer.id)

    const open = await call(fx.app, { url: `/objects/${folderId}`, as: fresh })
    expect(open.statusCode).toBe(200)

    const closed = await call(fx.app, { url: `/objects/${restrictedId}`, as: fresh })
    expect(closed.statusCode).toBe(404)
  })
})

describe('явная выдача прав', () => {
  it('выданный уровень действует и объясняется', async () => {
    const grant = await call(fx.app, {
      method: 'POST',
      url: `/objects/${restrictedId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'comment' }],
      },
    })
    expect(grant.statusCode).toBe(200)

    const card = await call(fx.app, { url: `/objects/${restrictedId}`, as: fx.users.stranger })
    expect(card.statusCode).toBe(200)
    expect(card.json().level).toBe('comment')

    const explain = await call(fx.app, {
      method: 'POST',
      url: `/objects/${restrictedId}/access/explain`,
      as: fx.admin,
      payload: { userId: fx.users.stranger.id },
    })
    expect(explain.json().level).toBe('comment')
    expect(explain.json().reasons.map((r: { kind: string }) => r.kind)).toContain('explicit')
  })

  it('уровень comment не даёт редактировать', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${restrictedId}`,
      as: fx.users.stranger,
      payload: { title: 'Попытка переименования' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('уровень comment не даёт делиться', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: `/objects/${restrictedId}/access`,
      as: fx.users.stranger,
      payload: { grants: [{ principal: { type: 'everyone', id: '*' }, level: 'view' }] },
    })
    expect(response.statusCode).toBe(403)
  })

  it('отзыв права возвращает 404', async () => {
    const revoke = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${restrictedId}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.stranger.id } },
    })
    expect(revoke.statusCode).toBe(200)

    const card = await call(fx.app, { url: `/objects/${restrictedId}`, as: fx.users.stranger })
    expect(card.statusCode).toBe(404)
  })
})

describe('наследование по дереву', () => {
  it('право на папке распространяется на вложенные объекты', async () => {
    const child = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Вложенная', spaceId: fx.spaceId, parentId: restrictedId },
    })
    expect(child.statusCode).toBe(200)
    const childId = child.json().id

    const before = await call(fx.app, { url: `/objects/${childId}`, as: fx.users.stranger })
    expect(before.statusCode).toBe(404)

    await call(fx.app, {
      method: 'POST',
      url: `/objects/${restrictedId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
      },
    })

    const after = await call(fx.app, { url: `/objects/${childId}`, as: fx.users.stranger })
    expect(after.statusCode).toBe(200)
    expect(after.json().level).toBe('view')
    expect(after.json().allowedActions.some((a: string) => a.endsWith('.edit'))).toBe(false)
  })
})

describe('списки, поиск и связи', () => {
  it('недоступный объект отсутствует в списке', async () => {
    const list = await call(fx.app, {
      url: `/objects?spaceId=${fx.spaceId}&limit=100`,
      as: fx.users.stranger,
    })
    const ids = list.json().items.map((i: { id: string }) => i.id)
    expect(ids).not.toContain(folderId)
  })

  it('связь на недоступный объект отдаётся без названия', async () => {
    const target = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: 'Секретная цель', spaceId: fx.spaceId },
    })
    const targetId = target.json().id
    await call(fx.app, {
      method: 'PUT',
      url: `/objects/${targetId}/access-mode`,
      as: fx.admin,
      payload: { mode: 'restricted' },
    })
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${restrictedId}/links`,
      as: fx.admin,
      payload: { targetId, kind: 'related' },
    })

    const links = await call(fx.app, {
      url: `/objects/${restrictedId}/links`,
      as: fx.users.stranger,
    })
    expect(links.statusCode).toBe(200)
    const hidden = links
      .json()
      .links.find((l: { object: { id: string } }) => l.object.id === targetId)
    expect(hidden).toBeDefined()
    expect(hidden.object.accessible).toBe(false)
    expect(hidden.object.title).toBe('')
  })

  it('batch-get скрывает недоступные объекты', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/objects/batch-get',
      as: fx.users.stranger,
      payload: { ids: [folderId] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().items[0].accessible).toBe(false)
    expect(response.json().items[0].title).toBe('')
  })
})

describe('способности', () => {
  it('без capability admin.system здоровье недоступно', async () => {
    const response = await call(fx.app, { url: '/admin/health', as: fx.users.member })
    expect(response.statusCode).toBe(403)
  })

  it('без capability spaces.create пространство не создать', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/spaces',
      as: fx.users.stranger,
      payload: { key: 'hack-space', name: 'Взлом' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('администратор имеет доступ ко всему', async () => {
    const response = await call(fx.app, { url: `/objects/${restrictedId}`, as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(response.json().level).toBe('owner')
  })
})

describe('CSRF', () => {
  it('изменяющий запрос без токена отклоняется', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/folders',
      headers: { cookie: fx.admin.cookie },
      payload: { name: 'Без CSRF', spaceId: fx.spaceId },
    })
    expect(response.statusCode).toBe(403)
  })

  it('чтение без CSRF разрешено', async () => {
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: fx.admin.cookie },
    })
    expect(response.statusCode).toBe(200)
  })
})
