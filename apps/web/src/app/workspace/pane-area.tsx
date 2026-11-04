import { cn, EmptyState, Panel, PanelGroup, ResizeHandle, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { LayoutGrid, PowerOff } from 'lucide-react'
import { Suspense, useRef } from 'react'
import { meQuery } from '~/shared/api/queries.js'
import { ViewBoundary } from '~/shared/errors/boundary.js'
import { useT } from '~/shared/i18n.js'
import { getObjectView, getScreen } from '~/shared/workspace/registry.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import type { PaneState, TabState } from '~/shared/workspace/types.js'
import { PaneLinkContext } from '~/shared/workspace/view-context.js'
import { TabBar } from './tab-bar.js'

export function PaneArea({ onOpenPalette }: { onOpenPalette: () => void }) {
  const panes = useWorkspace((s) => s.panes)
  const focusedPaneId = useWorkspace((s) => s.focusedPaneId)
  const focusPane = useWorkspace((s) => s.focusPane)

  if (panes.length === 1) {
    return <PaneView pane={panes[0]!} focused onFocus={focusPane} onOpenPalette={onOpenPalette} />
  }

  return (
    <PanelGroup direction="horizontal" autoSaveId="kchs.panes" className="min-h-0 flex-1">
      {panes.map((pane, index) => (
        <span key={pane.id} className="contents">
          {index > 0 ? <ResizeHandle /> : null}
          <Panel minSize={18} defaultSize={100 / panes.length} className="flex min-w-0 flex-col">
            <PaneView
              pane={pane}
              focused={pane.id === focusedPaneId}
              onFocus={focusPane}
              onOpenPalette={onOpenPalette}
            />
          </Panel>
        </span>
      ))}
    </PanelGroup>
  )
}

/** Вкладка держит живое соединение и не размонтируется при переключении (ADR-0228). */
function keptMounted(tab: TabState | undefined): boolean {
  return tab?.kind === 'object' && getObjectView(tab.objectType ?? '')?.keepMounted === true
}

function PaneView({
  pane,
  focused,
  onFocus,
  onOpenPalette,
}: {
  pane: PaneState
  focused: boolean
  onFocus: (paneId: string) => void
  onOpenPalette: () => void
}) {
  const t = useT()
  const tabs = useWorkspace((s) => s.tabs)
  const closeTab = useWorkspace((s) => s.closeTab)
  const linked = useWorkspace((s) => s.panes.length > 1)
  const activeTab = pane.activeTabId ? tabs[pane.activeTabId] : null
  // Вкладки со звонком, которые уже открывались в этой панели: они остаются
  // смонтированными и прячутся, пока активна другая вкладка
  const visited = useRef(new Set<string>())
  if (activeTab && keptMounted(activeTab)) visited.current.add(activeTab.id)
  for (const id of visited.current) {
    if (!pane.tabIds.includes(id) || !tabs[id]) visited.current.delete(id)
  }
  const mounted = pane.tabIds
    .map((id) => tabs[id])
    .filter(
      (tab): tab is TabState =>
        tab !== undefined && (tab.id === activeTab?.id || visited.current.has(tab.id)),
    )

  return (
    <section
      onMouseDownCapture={() => onFocus(pane.id)}
      onFocusCapture={() => onFocus(pane.id)}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-surface',
        !focused && 'opacity-[0.99]',
      )}
      aria-label={t('shell.pane.label')}
    >
      <TabBar pane={pane} focused={focused} onOpenPalette={onOpenPalette} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab ? (
          // Своё дерево у каждой вкладки: две вкладки одного типа не делят состояние
          // (секция карточки, несохранённая форма) — оно живёт в состоянии вкладки
          mounted.map((tab) => (
            <div key={tab.id} className={cn('h-full min-h-0', tab.id !== activeTab.id && 'hidden')}>
              {/* Упавший экран — объяснение и «Закрыть вкладку», а не белый лист (ADR-0228) */}
              <ViewBoundary onClose={() => closeTab(tab.id)}>
                <Suspense fallback={<PaneSkeleton />}>
                  {/* Связанные представления: группа панели — при нескольких панелях (ADR-0073) */}
                  <PaneLinkContext.Provider value={linked ? (pane.linkGroup ?? null) : null}>
                    <TabContent tab={tab} />
                  </PaneLinkContext.Provider>
                </Suspense>
              </ViewBoundary>
            </div>
          ))
        ) : (
          <EmptyState
            icon={<LayoutGrid />}
            title={t('shell.pane.emptyTitle')}
            description={t('shell.pane.emptyHint')}
          />
        )}
      </div>
    </section>
  )
}

function TabContent({ tab }: { tab: TabState }) {
  const t = useT()
  const { data: me } = useQuery(meQuery())
  // Экран выключенной возможности (15-admin-operations.md §1): ссылка из
  // закладок или прошлой сессии ведёт сюда — объясняем, а не показываем пустоту
  if (tab.kind === 'screen' && tab.screen && (me?.hiddenScreens ?? []).includes(tab.screen)) {
    return (
      <EmptyState
        icon={<PowerOff />}
        title={t('shell.pane.featureOff')}
        description={t('shell.pane.featureOffHint')}
      />
    )
  }
  if (tab.kind === 'object') {
    const view = getObjectView(tab.objectType ?? '')
    if (view) return <>{view.render(tab)}</>
    return (
      <EmptyState
        title={t('shell.pane.unsupportedType')}
        description={t('shell.pane.unsupportedTypeHint', { type: tab.objectType ?? '' })}
      />
    )
  }

  const screen = tab.screen ? getScreen(tab.screen) : undefined
  if (!screen) {
    return (
      <EmptyState
        title={t('shell.pane.inDevelopment')}
        description={t('shell.pane.inDevelopmentHint')}
      />
    )
  }
  return <>{screen.render(tab)}</>
}

function PaneSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-4 w-80" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    </div>
  )
}
