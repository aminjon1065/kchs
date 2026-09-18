import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Именованные рабочие пространства (P0-E14 S06): сохранение и открытие набора
 * вкладок; личные видит только владелец, общие — участники пространства.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

function layout(objectId?: string) {
  return {
    version: 1,
    tabs: {
      home: { id: 'home', kind: 'screen', screen: 'home', title: 'Мой день', pinned: true },
      files: {
        id: 'files',
        kind: 'screen',
        screen: 'files',
        title: 'Файлы',
        state: { collection: { mode: 'board' } },
      },
      ...(objectId
        ? { doc: { id: 'doc', kind: 'object', objectId, objectType: 'folder', title: 'Паводок' } }
        : {}),
    },
    panes: [
      { id: 'left', tabIds: ['home', 'files'], activeTabId: 'files' },
      ...(objectId ? [{ id: 'right', tabIds: ['doc'], activeTabId: 'doc' }] : []),
    ],
    focusedPaneId: 'left',
    contextOpen: true,
    contextTab: 'info',
  }
}

const names = (response: { json: () => { items: Array<{ title: string }> } }) =>
  response.json().items.map((item) => item.title)

describe('рабочие пространства', () => {
  it('личное: сохраняется с раскладкой и видно только владельцу', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.users.member,
      payload: { title: `Мой штаб ${run}`, layout: layout() },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    expect(created.json().layout.panes[0].tabIds).toEqual(['home', 'files'])
    expect(created.json().layout.tabs.files.state).toEqual({ collection: { mode: 'board' } })

    const mine = await call(fx.app, { url: '/workspaces', as: fx.users.member })
    const item = mine.json().items.find((entry: { id: string }) => entry.id === id)
    expect(item).toMatchObject({ title: `Мой штаб ${run}`, shared: false, tabCount: 2 })
    expect(item.layout).toBeUndefined()

    expect(names(await call(fx.app, { url: '/workspaces', as: fx.users.viewer }))).not.toContain(
      `Мой штаб ${run}`,
    )
    expect((await call(fx.app, { url: `/workspaces/${id}`, as: fx.users.viewer })).statusCode).toBe(
      404,
    )
  })

  it('общее: в пространстве команды, видно участникам, правит тот, у кого edit', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.admin,
      payload: {
        title: `Паводок-2026 ${run}`,
        shared: true,
        spaceId: fx.spaceId,
        layout: layout(fx.spaceId),
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    expect(names(await call(fx.app, { url: '/workspaces', as: fx.users.viewer }))).toContain(
      `Паводок-2026 ${run}`,
    )
    expect(names(await call(fx.app, { url: '/workspaces', as: fx.users.stranger }))).not.toContain(
      `Паводок-2026 ${run}`,
    )

    const byViewer = await call(fx.app, {
      method: 'PATCH',
      url: `/workspaces/${id}`,
      as: fx.users.viewer,
      payload: { title: 'Чужая правка' },
    })
    expect(byViewer.statusCode).toBe(403)

    const byMember = await call(fx.app, {
      method: 'PATCH',
      url: `/workspaces/${id}`,
      as: fx.users.member,
      payload: { layout: layout(), pinned: true },
    })
    expect(byMember.statusCode, byMember.body).toBe(200)
    expect(byMember.json().pinned).toBe(true)
    expect(byMember.json().layout.panes).toHaveLength(1)
  })

  it('общее нельзя сохранить без пространства или без права создавать в нём', async () => {
    const noSpace = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.admin,
      payload: { title: 'Без пространства', shared: true, layout: layout() },
    })
    expect(noSpace.statusCode).toBe(400)

    const viewer = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.users.viewer,
      payload: { title: 'От читателя', shared: true, spaceId: fx.spaceId, layout: layout() },
    })
    expect(viewer.statusCode).toBe(403)
  })

  it('раскладка проверяется: панель не может ссылаться на отсутствующую вкладку', async () => {
    const broken = layout()
    broken.panes[0]!.tabIds.push('ghost')
    const response = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.admin,
      payload: { title: 'Сломанное', layout: broken },
    })
    expect(response.statusCode).toBe(400)
  })

  it('удалённое рабочее пространство пропадает из списка', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/workspaces',
      as: fx.admin,
      payload: { title: `Временное ${run}`, layout: layout() },
    })
    const id = created.json().id as string
    const removed = await call(fx.app, { method: 'DELETE', url: `/objects/${id}`, as: fx.admin })
    expect(removed.statusCode).toBe(200)
    expect(names(await call(fx.app, { url: '/workspaces', as: fx.admin }))).not.toContain(
      `Временное ${run}`,
    )
  })
})
