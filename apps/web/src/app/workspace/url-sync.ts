import type { ObjectRecord } from '@kchs/contracts'
import { http } from '~/shared/api/client.js'
import { getObjectView, getScreen } from './registry.js'
import { useWorkspace } from './store.js'
import type { ScreenKey, TabState } from './types.js'

/**
 * Адрес страницы ↔ активная вкладка (02-platform-kernel.md §1: «открытие во
 * вкладке по /o/{id}»). Ссылки из уведомлений, писем и поиска открывают объект;
 * адрес активной вкладки можно скопировать и отправить коллеге.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const SCREEN_PATHS: Record<string, ScreenKey> = {
  '/inbox': 'inbox',
  '/notifications': 'notifications',
  '/search': 'search',
  '/files': 'files',
  '/spaces': 'spaces',
  '/data': 'data',
  '/maps': 'maps',
  '/documents': 'documents',
  '/tasks': 'tasks',
  '/chats': 'chats',
  '/meetings': 'meetings',
  '/calendar': 'calendar',
  '/knowledge': 'knowledge',
  '/admin': 'admin',
  '/profile': 'profile',
  '/trash': 'trash',
  '/processes': 'jobs',
  '/explore': 'explore',
}

export type LocationTarget =
  | { kind: 'object'; objectId: string }
  | { kind: 'screen'; screen: ScreenKey; params: Record<string, string> }

/** Любой путь с идентификатором объекта (`/o/<id>`, `/files/<id>`, `/spaces/<id>`) — объект. */
export function parseLocation(pathname: string, search = ''): LocationTarget | null {
  const ids = pathname.match(UUID)
  if (ids && ids.length > 0) return { kind: 'object', objectId: ids[ids.length - 1]!.toLowerCase() }
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return null
  const screen = SCREEN_PATHS[path]
  if (!screen) return null
  const params = Object.fromEntries(new URLSearchParams(search))
  return { kind: 'screen', screen, params }
}

export function locationOf(tab: TabState | undefined): string {
  if (!tab) return '/'
  if (tab.kind === 'object' && tab.objectId) return `/o/${tab.objectId}`
  if (tab.kind === 'screen' && tab.screen) {
    if (tab.screen === 'home') return '/'
    const path = Object.entries(SCREEN_PATHS).find(([, key]) => key === tab.screen)?.[0]
    if (!path) return '/'
    const query = new URLSearchParams(tab.params).toString()
    return query ? `${path}?${query}` : path
  }
  return '/'
}

function activeTab(): TabState | undefined {
  const state = useWorkspace.getState()
  const pane = state.panes.find((p) => p.id === state.focusedPaneId) ?? state.panes[0]
  return pane?.activeTabId ? state.tabs[pane.activeTabId] : undefined
}

/**
 * Открывает вкладку по адресу, с которым пришёл пользователь. Вызывается после
 * восстановления рабочего пространства, иначе восстановление перекрыло бы вкладку.
 */
export async function openFromLocation(
  translate: (key: string) => string,
  onUnavailable: () => void,
): Promise<void> {
  const target = parseLocation(window.location.pathname, window.location.search)
  if (!target) return
  const { openTab } = useWorkspace.getState()

  if (target.kind === 'screen') {
    const screen = getScreen(target.screen)
    if (!screen) return
    openTab({
      kind: 'screen',
      screen: target.screen,
      title: translate(screen.titleKey),
      icon: screen.icon,
      params: target.params,
      mode: 'permanent',
    })
    return
  }

  try {
    const object = await http.get<ObjectRecord>(`/objects/${target.objectId}`)
    // Обсуждение открывается в объекте, к которому оно относится
    const parentOfConversation =
      object.type === 'conversation' && typeof object.meta?.objectId === 'string'
        ? object.meta.objectId
        : null
    if (parentOfConversation) {
      window.history.replaceState(null, '', `/o/${parentOfConversation}`)
      return openFromLocation(translate, onUnavailable)
    }
    if (!getObjectView(object.type)) {
      onUnavailable()
      return
    }
    openTab({
      kind: 'object',
      objectId: object.id,
      objectType: object.type,
      title: object.title,
      mode: 'permanent',
    })
  } catch {
    onUnavailable()
  }
}

/** Адрес следует за активной вкладкой фокусной панели. */
export function subscribeUrlSync(): () => void {
  const write = () => {
    const next = locationOf(activeTab())
    const current = `${window.location.pathname}${window.location.search}`
    if (next !== current) window.history.replaceState(null, '', next)
  }
  return useWorkspace.subscribe(write)
}
