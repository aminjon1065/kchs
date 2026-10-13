import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetUnsavedWorkspace,
  readUnsavedWorkspace,
  rememberUnsavedWorkspace,
  savedWorkspaceSnapshot,
} from '~/shared/workspace/snapshot.js'
import type { WorkspaceSnapshot } from '~/shared/workspace/types.js'

const pane = { id: 'p1', tabIds: ['home'], activeTabId: 'home' }

describe('снимок рабочего пространства с сервера', () => {
  it('версия 1 с панелями восстанавливается как есть', () => {
    const snapshot = { version: 1, panes: [pane], tabs: {}, focusedPaneId: 'p1' }
    expect(savedWorkspaceSnapshot(snapshot)).toBe(snapshot)
  })

  it('нет состояния, не объект, чужая версия или без панелей — восстанавливать нечего', () => {
    for (const value of [null, undefined, 'state', 42, [pane]]) {
      expect(savedWorkspaceSnapshot(value)).toBeNull()
    }
    expect(savedWorkspaceSnapshot({ version: 2, panes: [pane] })).toBeNull()
    expect(savedWorkspaceSnapshot({ version: 1, panes: [] })).toBeNull()
    expect(savedWorkspaceSnapshot({ version: 1, panes: 'p1' })).toBeNull()
  })
})

/**
 * Снимок при перезагрузке: новая страница может прочесть состояние с сервера раньше, чем
 * дойдёт запрос keepalive, — свежий снимок берётся из хранилища вкладки, один раз и только
 * тем же сотрудником.
 */
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
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

const snapshot = {
  tabs: [],
  panes: [{ id: 'p1', tabIds: [], activeTabId: null }],
  focusedPaneId: 'p1',
  navigatorOpen: true,
  contextOpen: false,
  bottomOpen: false,
  contextTab: 'info',
  navigatorModule: null,
  version: 1,
} as unknown as WorkspaceSnapshot

beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()))
afterEach(() => vi.unstubAllGlobals())

describe('снимок при перезагрузке', () => {
  it('тот же сотрудник читает снимок, пока его не забыли', () => {
    rememberUnsavedWorkspace('u1', snapshot)
    // Строгий режим React запускает восстановление дважды — первое чтение не стирает
    expect(readUnsavedWorkspace('u1')).toEqual(snapshot)
    expect(readUnsavedWorkspace('u1')).toEqual(snapshot)
    forgetUnsavedWorkspace()
    expect(readUnsavedWorkspace('u1')).toBeNull()
  })

  it('другой сотрудник в той же вкладке чужих вкладок не получает', () => {
    rememberUnsavedWorkspace('u1', snapshot)
    expect(readUnsavedWorkspace('u2')).toBeNull()
  })

  it('сотрудник ещё неизвестен — снимок не применяется', () => {
    rememberUnsavedWorkspace('u1', snapshot)
    expect(readUnsavedWorkspace(null)).toBeNull()
  })
})
