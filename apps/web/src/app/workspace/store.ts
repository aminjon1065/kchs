import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getCsrfToken, http } from '~/shared/api/client.js'
import type {
  ContextTabKey,
  OpenTabInput,
  PaneState,
  ScreenKey,
  TabState,
  WorkspaceSnapshot,
} from './types.js'

const MAX_CLOSED = 20
const MAX_PANES = 4
const STORAGE_KEY = 'kchs.workspace'

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function homeTab(): TabState {
  return {
    id: 'tab_home',
    kind: 'screen',
    screen: 'home',
    title: 'Мой день',
    icon: 'home',
    preview: false,
    pinned: true,
    dirty: false,
    params: {},
    state: {},
  }
}

function initialSnapshot(): WorkspaceSnapshot {
  const home = homeTab()
  const pane: PaneState = { id: 'pane_main', tabIds: [home.id], activeTabId: home.id }
  return {
    tabs: { [home.id]: home },
    panes: [pane],
    focusedPaneId: pane.id,
    navigatorOpen: true,
    contextOpen: true,
    bottomOpen: false,
    contextTab: 'info',
    navigatorModule: 'home',
    version: 1,
  }
}

export interface WorkspaceStore extends WorkspaceSnapshot {
  closedStack: TabState[]
  /** Открыть вкладку по правилам поведения (03-ui/01-ux-concept.md §4). */
  openTab: (input: OpenTabInput) => string
  closeTab: (tabId: string) => void
  closeOthers: (tabId: string) => void
  closeToRight: (tabId: string) => void
  reopenClosed: () => void
  activateTab: (tabId: string, paneId?: string) => void
  activateByIndex: (index: number) => void
  cycleTab: (direction: 1 | -1) => void
  setTabTitle: (tabId: string, title: string) => void
  setTabDirty: (tabId: string, dirty: boolean) => void
  pinTab: (tabId: string, pinned: boolean) => void
  setTabGroup: (tabId: string, group: string | null) => void
  setTabState: (tabId: string, patch: Record<string, unknown>) => void
  makePermanent: (tabId: string) => void
  moveTabToPane: (tabId: string, paneId: string, index?: number) => void
  splitPane: (tabId?: string) => void
  closePane: (paneId: string) => void
  focusPane: (paneId: string) => void
  toggleNavigator: (open?: boolean) => void
  toggleContext: (open?: boolean) => void
  toggleBottom: (open?: boolean) => void
  setContextTab: (tab: ContextTabKey) => void
  setNavigatorModule: (module: ScreenKey) => void
  activeTab: () => TabState | null
  restore: (snapshot: WorkspaceSnapshot) => void
  reset: () => void
}

function sameTarget(tab: TabState, input: OpenTabInput): boolean {
  if (tab.kind !== input.kind) return false
  if (input.kind === 'object') return tab.objectId === input.objectId
  return (
    tab.screen === input.screen && JSON.stringify(tab.params) === JSON.stringify(input.params ?? {})
  )
}

export const useWorkspace = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      ...initialSnapshot(),
      closedStack: [],

      openTab: (input) => {
        const state = get()
        const mode = input.mode ?? 'preview'

        // Объект не открывается дважды — переключаемся на существующую вкладку
        const existing = Object.values(state.tabs).find((tab) => sameTarget(tab, input))
        if (existing && mode !== 'split') {
          const paneId =
            state.panes.find((p) => p.tabIds.includes(existing.id))?.id ?? state.focusedPaneId
          set({
            panes: state.panes.map((pane) =>
              pane.id === paneId ? { ...pane, activeTabId: existing.id } : pane,
            ),
            focusedPaneId: paneId,
            tabs:
              mode === 'permanent'
                ? { ...state.tabs, [existing.id]: { ...existing, preview: false } }
                : state.tabs,
          })
          return existing.id
        }

        const tab: TabState = {
          id: newId('tab'),
          kind: input.kind,
          screen: input.screen,
          objectId: input.objectId,
          objectType: input.objectType,
          title: input.title,
          icon: input.icon,
          preview: mode === 'preview',
          pinned: false,
          dirty: false,
          group: input.group ?? null,
          params: input.params ?? {},
          state: {},
        }

        if (mode === 'split') {
          const created = createPane(state.panes, tab.id)
          set({
            tabs: { ...state.tabs, [tab.id]: tab },
            panes: created.panes,
            focusedPaneId: created.paneId,
          })
          return tab.id
        }

        const targetPaneId = state.focusedPaneId
        const pane = state.panes.find((p) => p.id === targetPaneId) ?? state.panes[0]!
        const tabs = { ...state.tabs, [tab.id]: tab }
        let tabIds = [...pane.tabIds]

        // Предварительная вкладка заменяется следующей предварительной
        if (mode === 'preview') {
          const previewId = pane.tabIds.find(
            (id) => state.tabs[id]?.preview && !state.tabs[id]?.dirty,
          )
          if (previewId) {
            tabIds = tabIds.map((id) => (id === previewId ? tab.id : id))
            delete tabs[previewId]
          } else {
            tabIds.push(tab.id)
          }
        } else {
          tabIds.push(tab.id)
        }

        set({
          tabs,
          panes: state.panes.map((p) =>
            p.id === pane.id
              ? { ...p, tabIds, activeTabId: mode === 'background' ? p.activeTabId : tab.id }
              : p,
          ),
        })
        return tab.id
      },

      closeTab: (tabId) => {
        const state = get()
        const tab = state.tabs[tabId]
        if (!tab || tab.pinned) return

        const panes = state.panes
          .map((pane) => {
            if (!pane.tabIds.includes(tabId)) return pane
            const tabIds = pane.tabIds.filter((id) => id !== tabId)
            const activeTabId =
              pane.activeTabId === tabId
                ? (tabIds[Math.max(0, pane.tabIds.indexOf(tabId) - 1)] ?? tabIds[0] ?? null)
                : pane.activeTabId
            return { ...pane, tabIds, activeTabId }
          })
          .filter((pane, index) => pane.tabIds.length > 0 || index === 0)

        const tabs = { ...state.tabs }
        delete tabs[tabId]

        set({
          tabs,
          panes: panes.length > 0 ? panes : initialSnapshot().panes,
          focusedPaneId: panes.some((p) => p.id === state.focusedPaneId)
            ? state.focusedPaneId
            : (panes[0]?.id ?? 'pane_main'),
          closedStack: [tab, ...state.closedStack].slice(0, MAX_CLOSED),
        })
      },

      closeOthers: (tabId) => {
        const state = get()
        const pane = state.panes.find((p) => p.tabIds.includes(tabId))
        if (!pane) return
        for (const id of pane.tabIds) {
          if (id !== tabId && !state.tabs[id]?.pinned) get().closeTab(id)
        }
      },

      closeToRight: (tabId) => {
        const state = get()
        const pane = state.panes.find((p) => p.tabIds.includes(tabId))
        if (!pane) return
        const index = pane.tabIds.indexOf(tabId)
        for (const id of pane.tabIds.slice(index + 1)) {
          if (!state.tabs[id]?.pinned) get().closeTab(id)
        }
      },

      reopenClosed: () => {
        const state = get()
        const [tab, ...rest] = state.closedStack
        if (!tab) return
        const pane = state.panes.find((p) => p.id === state.focusedPaneId) ?? state.panes[0]!
        set({
          tabs: { ...state.tabs, [tab.id]: { ...tab, preview: false } },
          panes: state.panes.map((p) =>
            p.id === pane.id ? { ...p, tabIds: [...p.tabIds, tab.id], activeTabId: tab.id } : p,
          ),
          closedStack: rest,
        })
      },

      activateTab: (tabId, paneId) => {
        const state = get()
        const targetPane =
          paneId ?? state.panes.find((p) => p.tabIds.includes(tabId))?.id ?? state.focusedPaneId
        set({
          panes: state.panes.map((pane) =>
            pane.id === targetPane ? { ...pane, activeTabId: tabId } : pane,
          ),
          focusedPaneId: targetPane,
        })
      },

      activateByIndex: (index) => {
        const state = get()
        const pane = state.panes.find((p) => p.id === state.focusedPaneId)
        const tabId = pane?.tabIds[index]
        if (tabId) get().activateTab(tabId)
      },

      cycleTab: (direction) => {
        const state = get()
        const pane = state.panes.find((p) => p.id === state.focusedPaneId)
        if (!pane || pane.tabIds.length < 2) return
        const current = pane.activeTabId ? pane.tabIds.indexOf(pane.activeTabId) : 0
        const next = (current + direction + pane.tabIds.length) % pane.tabIds.length
        get().activateTab(pane.tabIds[next]!)
      },

      setTabTitle: (tabId, title) => {
        const tab = get().tabs[tabId]
        if (!tab || tab.title === title) return
        set({ tabs: { ...get().tabs, [tabId]: { ...tab, title } } })
      },

      setTabDirty: (tabId, dirty) => {
        const tab = get().tabs[tabId]
        if (!tab || tab.dirty === dirty) return
        set({
          tabs: { ...get().tabs, [tabId]: { ...tab, dirty, preview: dirty ? false : tab.preview } },
        })
      },

      pinTab: (tabId, pinned) => {
        const state = get()
        const tab = state.tabs[tabId]
        if (!tab) return
        set({ tabs: { ...state.tabs, [tabId]: { ...tab, pinned, preview: false } } })
      },

      setTabGroup: (tabId, group) => {
        const tab = get().tabs[tabId]
        if (!tab) return
        set({ tabs: { ...get().tabs, [tabId]: { ...tab, group } } })
      },

      setTabState: (tabId, patch) => {
        const tab = get().tabs[tabId]
        if (!tab) return
        set({ tabs: { ...get().tabs, [tabId]: { ...tab, state: { ...tab.state, ...patch } } } })
      },

      makePermanent: (tabId) => {
        const tab = get().tabs[tabId]
        if (!tab?.preview) return
        set({ tabs: { ...get().tabs, [tabId]: { ...tab, preview: false } } })
      },

      moveTabToPane: (tabId, paneId, index) => {
        const state = get()
        if (state.panes.find((p) => p.id === paneId)?.tabIds.includes(tabId)) return

        const panes = state.panes
          .map((pane) => {
            if (pane.tabIds.includes(tabId)) {
              const tabIds = pane.tabIds.filter((id) => id !== tabId)
              return {
                ...pane,
                tabIds,
                activeTabId: pane.activeTabId === tabId ? (tabIds[0] ?? null) : pane.activeTabId,
              }
            }
            if (pane.id === paneId) {
              const tabIds = [...pane.tabIds]
              tabIds.splice(index ?? tabIds.length, 0, tabId)
              return { ...pane, tabIds, activeTabId: tabId }
            }
            return pane
          })
          .filter((pane, i) => pane.tabIds.length > 0 || i === 0)

        set({ panes, focusedPaneId: paneId })
      },

      splitPane: (tabId) => {
        const state = get()
        if (state.panes.length >= MAX_PANES) return
        const sourceTabId =
          tabId ?? state.panes.find((p) => p.id === state.focusedPaneId)?.activeTabId ?? null
        if (!sourceTabId) return

        const sourcePane = state.panes.find((p) => p.tabIds.includes(sourceTabId))
        if (sourcePane && sourcePane.tabIds.length === 1) {
          // Единственная вкладка: дублируем её в новую панель
          const source = state.tabs[sourceTabId]!
          const clone: TabState = { ...source, id: newId('tab'), preview: false }
          const created = createPane(state.panes, clone.id)
          set({
            tabs: { ...state.tabs, [clone.id]: clone },
            panes: created.panes,
            focusedPaneId: created.paneId,
          })
          return
        }

        const created = createPane(state.panes, sourceTabId)
        const panes = created.panes.map((pane) =>
          pane.id !== created.paneId && pane.tabIds.includes(sourceTabId)
            ? {
                ...pane,
                tabIds: pane.tabIds.filter((id) => id !== sourceTabId),
                activeTabId:
                  pane.activeTabId === sourceTabId
                    ? (pane.tabIds.filter((id) => id !== sourceTabId)[0] ?? null)
                    : pane.activeTabId,
              }
            : pane,
        )
        set({ panes, focusedPaneId: created.paneId })
      },

      closePane: (paneId) => {
        const state = get()
        if (state.panes.length <= 1) return
        const pane = state.panes.find((p) => p.id === paneId)
        if (!pane) return
        const tabs = { ...state.tabs }
        for (const id of pane.tabIds) if (!tabs[id]?.pinned) delete tabs[id]
        const panes = state.panes.filter((p) => p.id !== paneId)
        set({ tabs, panes, focusedPaneId: panes[0]!.id })
      },

      focusPane: (paneId) => set({ focusedPaneId: paneId }),

      toggleNavigator: (open) => set((s) => ({ navigatorOpen: open ?? !s.navigatorOpen })),
      toggleContext: (open) => set((s) => ({ contextOpen: open ?? !s.contextOpen })),
      toggleBottom: (open) => set((s) => ({ bottomOpen: open ?? !s.bottomOpen })),
      setContextTab: (contextTab) => set({ contextTab, contextOpen: true }),
      setNavigatorModule: (navigatorModule) => set({ navigatorModule }),

      activeTab: () => {
        const state = get()
        const pane = state.panes.find((p) => p.id === state.focusedPaneId) ?? state.panes[0]
        return pane?.activeTabId ? (state.tabs[pane.activeTabId] ?? null) : null
      },

      restore: (snapshot) => {
        if (snapshot?.version !== 1 || !snapshot.panes?.length) return
        set({ ...snapshot, closedStack: [] })
      },

      reset: () => set({ ...initialSnapshot(), closedStack: [] }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        panes: state.panes,
        focusedPaneId: state.focusedPaneId,
        navigatorOpen: state.navigatorOpen,
        contextOpen: state.contextOpen,
        bottomOpen: state.bottomOpen,
        contextTab: state.contextTab,
        navigatorModule: state.navigatorModule,
        version: state.version,
      }),
    },
  ),
)

function createPane(panes: PaneState[], tabId: string): { panes: PaneState[]; paneId: string } {
  const paneId = newId('pane')
  return {
    panes: [...panes, { id: paneId, tabIds: [tabId], activeTabId: tabId }],
    paneId,
  }
}

/** Сохранение состояния на сервере с дебаунсом — «Продолжить» между днями. */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave = false

function snapshot(): WorkspaceSnapshot {
  const state = useWorkspace.getState()
  return {
    tabs: state.tabs,
    panes: state.panes,
    focusedPaneId: state.focusedPaneId,
    navigatorOpen: state.navigatorOpen,
    contextOpen: state.contextOpen,
    bottomOpen: state.bottomOpen,
    contextTab: state.contextTab,
    navigatorModule: state.navigatorModule,
    version: 1,
  }
}

export function scheduleWorkspaceSave(): void {
  pendingSave = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    pendingSave = false
    void http.put('/me/workspace-state', { state: snapshot() }).catch(() => undefined)
  }, 2500)
}

/**
 * Досрочная отправка при уходе со страницы: перезагрузка сразу после
 * разделения панелей не должна терять рабочий контекст.
 */
export function flushWorkspaceSave(): void {
  if (!pendingSave) return
  pendingSave = false
  if (saveTimer) clearTimeout(saveTimer)

  const csrfToken = getCsrfToken()
  void fetch('/api/v1/me/workspace-state', {
    method: 'PUT',
    keepalive: true,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    body: JSON.stringify({ state: snapshot() }),
  }).catch(() => undefined)
}

export function subscribeWorkspaceSave(): () => void {
  const unsubscribe = useWorkspace.subscribe(() => scheduleWorkspaceSave())
  const onHide = () => flushWorkspaceSave()
  window.addEventListener('pagehide', onHide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWorkspaceSave()
  })
  return () => {
    unsubscribe()
    window.removeEventListener('pagehide', onHide)
  }
}
