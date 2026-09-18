import { cn, IconButton, Tooltip, useBreakpoint, useHotkeys } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ActingBanner } from '~/features/delegation/acting-banner.js'
import { CreateSpaceDialog } from '~/features/spaces/create-space-dialog.js'
import { http } from '~/shared/api/client.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import {
  connectRealtime,
  disconnectRealtime,
  subscribeRooms,
  unsubscribeRooms,
} from '~/shared/realtime/client.js'
import { useT } from '../i18n.js'
import { CommandPalette } from './command-palette.js'
import { ContextPanel } from './context-panel.js'
import { MobileNav } from './mobile-nav.js'
import { Navigator } from './navigator.js'
import { PaneArea } from './pane-area.js'
import { Rail } from './rail.js'
import { ShortcutsOverlay } from './shortcuts.js'
import { StatusBar } from './status-bar.js'
import { subscribeWorkspaceSave, useWorkspace } from './store.js'
import type { WorkspaceSnapshot } from './types.js'

export function WorkspaceShell() {
  const t = useT()
  const client = useQueryClient()
  const breakpoint = useBreakpoint()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false)

  const navigatorOpen = useWorkspace((s) => s.navigatorOpen)
  const contextOpen = useWorkspace((s) => s.contextOpen)
  const toggleNavigator = useWorkspace((s) => s.toggleNavigator)
  const toggleContext = useWorkspace((s) => s.toggleContext)
  const toggleBottom = useWorkspace((s) => s.toggleBottom)
  const openTab = useWorkspace((s) => s.openTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const reopenClosed = useWorkspace((s) => s.reopenClosed)
  const splitPane = useWorkspace((s) => s.splitPane)
  const activateByIndex = useWorkspace((s) => s.activateByIndex)
  const cycleTab = useWorkspace((s) => s.cycleTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const restore = useWorkspace((s) => s.restore)

  useQuery(meQuery())

  // Восстановление рабочего контекста с сервера («Продолжить»)
  useEffect(() => {
    let cancelled = false
    void http
      .get<{ state: WorkspaceSnapshot | null }>('/me/workspace-state')
      .then((result) => {
        if (!cancelled && result.state) restore(result.state)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [restore])

  useEffect(() => subscribeWorkspaceSave(), [])

  useEffect(() => {
    connectRealtime(client, {
      onInboxChanged: () => void client.invalidateQueries({ queryKey: keys.inboxCounts }),
      onAclRevoked: ({ objectId }) => {
        const tab = Object.values(useWorkspace.getState().tabs).find((t) => t.objectId === objectId)
        if (tab) useWorkspace.getState().closeTab(tab.id)
      },
    })
    return () => disconnectRealtime()
  }, [client])

  // Комнаты открытых вкладок: изменения объекта приходят в реальном времени
  const openObjectIds = useWorkspace((s) =>
    Object.values(s.tabs)
      .map((tab) => tab.objectId)
      .filter((id): id is string => Boolean(id))
      .sort()
      .join(','),
  )
  useEffect(() => {
    const rooms = openObjectIds ? openObjectIds.split(',').map((id) => `object:${id}`) : []
    if (rooms.length === 0) return
    subscribeRooms(rooms)
    return () => unsubscribeRooms(rooms)
  }, [openObjectIds])

  // На узких экранах панели прячутся, при возврате к широкому — восстанавливаются
  const panelsBeforeNarrow = useRef<{ navigator: boolean; context: boolean } | null>(null)
  useEffect(() => {
    const narrow = breakpoint === 'mobile' || breakpoint === 'tablet'
    const state = useWorkspace.getState()

    if (narrow) {
      panelsBeforeNarrow.current ??= {
        navigator: state.navigatorOpen,
        context: state.contextOpen,
      }
      toggleNavigator(false)
      toggleContext(false)
      return
    }

    if (panelsBeforeNarrow.current) {
      toggleNavigator(panelsBeforeNarrow.current.navigator)
      toggleContext(panelsBeforeNarrow.current.context && breakpoint === 'desktop')
      panelsBeforeNarrow.current = null
      return
    }

    // 1280–1440: контекст-панель по умолчанию свёрнута (03-ui/01-ux-concept.md §9)
    if (breakpoint === 'laptop') toggleContext(false)
  }, [breakpoint, toggleNavigator, toggleContext])

  const goScreen = (
    screen: Parameters<typeof openTab>[0]['screen'],
    titleKey: string,
    icon: string,
  ) => {
    if (!screen) return
    setNavigatorModule(screen)
    openTab({ kind: 'screen', screen, title: t(titleKey), icon, mode: 'permanent' })
  }

  useHotkeys([
    { combo: 'mod+k', handler: () => setPaletteOpen(true), allowInInput: true },
    { combo: 'mod+b', handler: () => toggleNavigator() },
    { combo: 'mod+.', handler: () => toggleContext() },
    { combo: 'mod+j', handler: () => toggleBottom() },
    { combo: 'mod+t', handler: () => setPaletteOpen(true) },
    { combo: 'mod+\\', handler: () => splitPane() },
    { combo: 'mod+shift+t', handler: () => reopenClosed() },
    {
      combo: 'mod+w',
      handler: () => {
        const tab = useWorkspace.getState().activeTab()
        if (tab) closeTab(tab.id)
      },
    },
    { combo: 'shift+?', handler: () => setShortcutsOpen(true) },
    { combo: 'g h', handler: () => goScreen('home', 'shell.rail.home', 'home') },
    { combo: 'g i', handler: () => goScreen('inbox', 'shell.rail.inbox', 'inbox') },
    { combo: 'g f', handler: () => goScreen('files', 'shell.rail.files', 'folder') },
    ...Array.from({ length: 9 }, (_, index) => ({
      combo: `mod+${index + 1}`,
      handler: () => activateByIndex(index),
    })),
    { combo: 'ctrl+tab', handler: () => cycleTab(1), allowInInput: true },
  ])

  const isMobile = breakpoint === 'mobile'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ActingBanner />
      <div className="flex min-h-0 flex-1">
        {isMobile ? null : <Rail onOpenPalette={() => setPaletteOpen(true)} />}

        {navigatorOpen ? (
          <Navigator onCreateSpace={() => setCreateSpaceOpen(true)} />
        ) : isMobile ? null : (
          <div className="flex w-8 shrink-0 flex-col items-center border-r border-line bg-surface-2 pt-2">
            <Tooltip content={t('shell.navigator.expand')} side="right" shortcut="mod+b">
              <IconButton
                label={t('shell.navigator.expand')}
                size="sm"
                onClick={() => toggleNavigator(true)}
              >
                <PanelLeftOpen className="size-3.5" />
              </IconButton>
            </Tooltip>
          </div>
        )}

        <main className={cn('flex min-w-0 flex-1 flex-col')}>
          <PaneArea onOpenPalette={() => setPaletteOpen(true)} />
        </main>

        {contextOpen ? (
          <ContextPanel />
        ) : isMobile ? null : (
          <div className="flex w-8 shrink-0 flex-col items-center border-l border-line bg-surface-2 pt-2">
            <Tooltip content={t('shell.context.title')} side="left" shortcut="mod+.">
              <IconButton
                label={t('shell.context.title')}
                size="sm"
                onClick={() => toggleContext(true)}
              >
                <PanelRightOpen className="size-3.5" />
              </IconButton>
            </Tooltip>
          </div>
        )}
      </div>

      {isMobile ? (
        <MobileNav onOpenPalette={() => setPaletteOpen(true)} />
      ) : (
        <StatusBar onShowShortcuts={() => setShortcutsOpen(true)} />
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsOverlay open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <CreateSpaceDialog open={createSpaceOpen} onOpenChange={setCreateSpaceOpen} />
    </div>
  )
}
