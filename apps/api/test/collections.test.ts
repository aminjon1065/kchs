import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext, uploadFile } from './helpers.js'

/**
 * Списки объектов для CollectionView (P0-E12 S03): фильтр в общем формате,
 * сортировка по объявленным полям, подсчёт, сохранённые представления.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)
let small: string
let big: string

beforeAll(async () => {
  fx = await setupFixture()
  small = (
    await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `Альфа ${run}.txt`,
      content: 'x',
    })
  ).id
  big = (
    await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: `Бета 100% ${run}.txt`,
      content: 'y'.repeat(5000),
    })
  ).id
})

async function list(params: Record<string, string>) {
  const query = new URLSearchParams({ type: 'file', limit: '50', ...params })
  return call(fx.app, { url: `/objects?${query}`, as: fx.admin })
}

const ids = (response: { json: () => { items: Array<{ id: string }> } }) =>
  response.json().items.map((item) => item.id)

describe('списки объектов: фильтр и сортировка', () => {
  it('схема полей типа: общие поля и поля модуля', async () => {
    const response = await call(fx.app, { url: '/objects/fields?type=file', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const keys = response.json().items.map((f: { key: string }) => f.key)
    expect(keys).toEqual(expect.arrayContaining(['title', 'updatedAt', 'size', 'mime']))
  })

  it('фильтр по тексту и числу из meta модуля', async () => {
    const byTitle = await list({
      filter: JSON.stringify({ field: 'title', op: 'contains', value: `Альфа ${run}` }),
    })
    expect(byTitle.statusCode).toBe(200)
    expect(ids(byTitle)).toEqual([small])

    const bySize = await list({
      filter: JSON.stringify({
        and: [
          { field: 'size', op: 'gt', value: 1000 },
          { field: 'title', op: 'contains', value: run },
        ],
      }),
    })
    expect(ids(bySize)).toEqual([big])
  })

  it('смешанный список папок и файлов фильтруется полями модуля', async () => {
    const fields = await call(fx.app, { url: '/objects/fields?types=folder,file', as: fx.admin })
    expect(fields.json().items.map((f: { key: string }) => f.key)).toContain('size')
    const query = new URLSearchParams({
      types: 'folder,file',
      spaceId: fx.spaceId,
      filter: JSON.stringify({
        and: [
          { field: 'size', op: 'gte', value: 1 },
          { field: 'title', op: 'contains', value: run },
        ],
      }),
      sort: 'size:asc',
    })
    const response = await call(fx.app, { url: `/objects?${query}`, as: fx.admin })
    expect(response.statusCode).toBe(200)
    expect(ids(response)).toEqual([small, big])
  })

  it('знак % в тексте ищется буквально', async () => {
    const response = await list({
      filter: JSON.stringify({ field: 'title', op: 'contains', value: '100%' }),
      q: run,
    })
    expect(ids(response)).toEqual([big])
    const noWildcard = await list({ q: `${run}%` })
    expect(ids(noWildcard)).toEqual([])
  })

  it('владелец @me, относительный период и логические группы', async () => {
    const response = await list({
      filter: JSON.stringify({
        and: [
          { field: 'ownerId', op: 'is_me' },
          { field: 'createdAt', op: 'relative', value: { unit: 'day', from: 0, to: 0 } },
          {
            or: [
              { field: 'title', op: 'starts_with', value: 'Альфа' },
              { field: 'title', op: 'starts_with', value: 'Бета' },
            ],
          },
          { field: 'title', op: 'contains', value: run },
        ],
      }),
      sort: 'title:asc',
      count: 'true',
    })
    expect(response.statusCode).toBe(200)
    expect(ids(response)).toEqual([small, big])
    expect(response.json().total).toBe(2)

    const desc = await list({
      filter: JSON.stringify({ field: 'title', op: 'contains', value: run }),
      sort: 'size:desc',
    })
    expect(ids(desc)).toEqual([big, small])
  })

  it('неизвестное поле, чужой оператор и сортировка по несортируемому — 400', async () => {
    const cases: Array<Record<string, string>> = [
      { filter: JSON.stringify({ field: 'passwordHash', op: 'eq', value: 'x' }) },
      { filter: JSON.stringify({ field: 'size', op: 'contains', value: 'x' }) },
      { filter: JSON.stringify({ field: 'title', op: 'eq' }) },
      { filter: '{"broken json' },
      { sort: 'mime:asc' },
    ]
    for (const params of cases) {
      const response = await list(params)
      expect(response.statusCode, JSON.stringify(params)).toBe(400)
    }
  })

  it('страницы произвольной сортировки идут без повторов', async () => {
    const first = await list({
      filter: JSON.stringify({ field: 'title', op: 'contains', value: run }),
      sort: 'title:asc',
      limit: '1',
    })
    const cursor = first.json().nextCursor as string
    expect(cursor).toBeTruthy()
    const second = await list({
      filter: JSON.stringify({ field: 'title', op: 'contains', value: run }),
      sort: 'title:asc',
      limit: '1',
      cursor,
    })
    expect([...ids(first), ...ids(second)]).toEqual([small, big])
  })
})

describe('сохранённые представления', () => {
  const definition = {
    mode: 'table',
    filter: { field: 'size', op: 'gt', value: 1000 },
    sort: [{ field: 'title', direction: 'asc' }],
    columns: [{ key: 'title' }, { key: 'size', width: 120 }],
  }

  it('личное представление видит только автор', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/views',
      as: fx.users.member,
      payload: { title: 'Большие файлы', objectType: 'file', shared: false, definition },
    })
    expect(created.statusCode).toBe(200)
    const view = created.json()
    expect(view.definition.filter).toEqual(definition.filter)
    expect(view.definition.groupBy).toBeNull()

    const mine = await call(fx.app, { url: '/views?objectType=file', as: fx.users.member })
    expect(mine.json().items.map((v: { id: string }) => v.id)).toContain(view.id)
    const theirs = await call(fx.app, { url: '/views?objectType=file', as: fx.users.viewer })
    expect(theirs.json().items.map((v: { id: string }) => v.id)).not.toContain(view.id)
    expect((await call(fx.app, { url: `/views/${view.id}`, as: fx.users.viewer })).statusCode).toBe(
      404,
    )
  })

  it('общее представление пространства видят участники, чужие — нет', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/views',
      as: fx.users.member,
      payload: {
        title: 'Файлы команды',
        objectType: 'file',
        shared: true,
        spaceId: fx.spaceId,
        definition: { ...definition, mode: 'board', groupBy: 'mime' },
      },
    })
    expect(created.statusCode).toBe(200)
    const id = created.json().id as string

    const viewer = await call(fx.app, {
      url: `/views?objectType=file&spaceId=${fx.spaceId}`,
      as: fx.users.viewer,
    })
    expect(viewer.json().items.map((v: { id: string }) => v.id)).toContain(id)
    const stranger = await call(fx.app, { url: '/views?objectType=file', as: fx.users.stranger })
    expect(stranger.json().items.map((v: { id: string }) => v.id)).not.toContain(id)

    // Читатель пространства не может публиковать общие представления
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/views',
      as: fx.users.viewer,
      payload: {
        title: 'Нельзя',
        objectType: 'file',
        shared: true,
        spaceId: fx.spaceId,
        definition,
      },
    })
    expect(denied.statusCode).toBe(403)

    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/views/${id}`,
      as: fx.users.member,
      payload: { title: 'Файлы команды — доска', pinned: true },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ title: 'Файлы команды — доска', pinned: true })
  })
})
