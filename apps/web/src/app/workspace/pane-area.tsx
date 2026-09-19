import { cn, EmptyState, Panel, PanelGroup, ResizeHandle, Skeleton } from '@kchs/ui'
import { LayoutGrid } from 'lucide-react'
import { Suspense } from 'react'
import { useT } from '../i18n.js'
import { getObjectView, getScreen } from './registry.js'
import { useWorkspace } from './store.js'
import { TabBar } from './tab-bar.js'
import type { PaneState, TabState } from './types.js'
import { PaneLinkContext } from './view-context.js'

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
  const linked = useWorkspace((s) => s.panes.length > 1)
  const activeTab = pane.activeTabId ? tabs[pane.activeTabId] : null

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
          <Suspense fallback={<PaneSkeleton />}>
            {/* Связанные представления: группа панели — при нескольких панелях (ADR-0073) */}
            <PaneLinkContext.Provider value={linked ? (pane.linkGroup ?? null) : null}>
              <TabContent tab={activeTab} />
            </PaneLinkContext.Provider>
          </Suspense>
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
