import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Сохранение рабочего пространства (ADR-0222): на сервер уходит только изменение снимка.
 * Восстановление с сервера и якорь обсуждения запроса не порождают.
 */
const put = vi.fn(async () => ({}))
vi.mock('~/shared/api/client.js', () => ({ http: { put } }))

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

// Хранилище и события страницы — до загрузки хранилища вкладок
vi.stubGlobal('localStorage', memoryStorage())
vi.stubGlobal('sessionStorage', memoryStorage())
vi.stubGlobal('window', new EventTarget())
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))

const { useWorkspace, subscribeWorkspaceSave } = await import('~/shared/workspace/store.js')

let unsubscribe: () => void = () => undefined

beforeAll(() => {
  vi.useFakeTimers()
  unsubscribe = subscribeWorkspaceSave('u1')
})

afterAll(() => {
  unsubscribe()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await vi.runAllTimersAsync()
  put.mockClear()
})

async function saves(): Promise<number> {
  await vi.advanceTimersByTimeAsync(3000)
  return put.mock.calls.length
}

describe('сохранение рабочего пространства', () => {
  it('восстановление с сервера не отправляет снимок обратно', async () => {
    const tab = { id: 't1', kind: 'screen', screen: 'home', title: 'Главная', params: {} }
    useWorkspace.getState().restore({
      version: 1,
      tabs: { t1: tab },
      panes: [{ id: 'p1', tabIds: ['t1'], activeTabId: 't1', linkGroup: null }],
      focusedPaneId: 'p1',
      navigatorOpen: true,
      contextOpen: false,
      bottomOpen: false,
      contextTab: 'details',
      navigatorModule: null,
    } as never)
    expect(await saves()).toBe(0)
  })

  it('якорь обсуждения — не снимок', async () => {
    useWorkspace.getState().toggleContext(true)
    expect(await saves(), 'открытая панель — часть снимка').toBe(1)
    put.mockClear()
    const { contextTab } = useWorkspace.getState()
    useWorkspace.getState().setContextTab(contextTab, 'anchor-1')
    useWorkspace.getState().setContextTab(contextTab, 'anchor-2')
    expect(await saves()).toBe(0)
  })

  it('изменение снимка сохраняется один раз после паузы', async () => {
    useWorkspace.getState().openTab({ kind: 'screen', screen: 'inbox', title: 'Входящие' })
    useWorkspace.getState().toggleBottom(true)
    expect(await saves()).toBe(1)
  })
})
