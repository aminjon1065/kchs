import { describe, expect, it } from 'vitest'
import { savedWorkspaceSnapshot } from '~/shared/workspace/snapshot.js'

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
