import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ObjectIcon,
  Tooltip,
} from '@kchs/ui'
import { Columns2, Pin, PinOff, Plus, X } from 'lucide-react'
import { type DragEvent, useRef } from 'react'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { PaneState, TabState } from './types.js'

const GROUP_COLORS: Record<string, string> = {
  blue: 'bg-chart-1',
  orange: 'bg-chart-2',
  green: 'bg-chart-3',
  red: 'bg-chart-4',
  purple: 'bg-chart-5',
}

export function TabBar({
  pane,
  focused,
  onOpenPalette,
}: {
  pane: PaneState
  focused: boolean
  onOpenPalette: () => void
}) {
  const t = useT()
  const tabs = useWorkspace((s) => s.tabs)
  const activateTab = useWorkspace((s) => s.activateTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const makePermanent = useWorkspace((s) => s.makePermanent)
  const moveTabToPane = useWorkspace((s) => s.moveTabToPane)
  const splitPane = useWorkspace((s) => s.splitPane)
  const closePane = useWorkspace((s) => s.closePane)
  const panesCount = useWorkspace((s) => s.panes.length)
  const dragTabId = useRef<string | null>(null)

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    const tabId = event.dataTransfer.getData('text/kchs-tab') || dragTabId.current
    if (tabId) moveTabToPane(tabId, pane.id)
  }

  return (
    <div
      className={cn(
        'flex h-(--tab-h) shrink-0 items-center gap-0.5 border-b border-line bg-surface-2 pl-1 pr-1',
        focused && panesCount > 1 && 'bg-surface',
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      role="tablist"
      aria-label="Вкладки"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {pane.tabIds.map((tabId) => {
          const tab = tabs[tabId]
          if (!tab) return null
          return (
            <TabChip
              key={tabId}
              tab={tab}
              active={pane.activeTabId === tabId}
              onActivate={() => activateTab(tabId, pane.id)}
              onDoubleClick={() => makePermanent(tabId)}
              onClose={() => closeTab(tabId)}
              onDragStart={(event) => {
                dragTabId.current = tabId
                event.dataTransfer.setData('text/kchs-tab', tabId)
                event.dataTransfer.effectAllowed = 'move'
              }}
            />
          )
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t('shell.tabs.close')} shortcut="mod+t">
          <IconButton label="Новая вкладка" size="sm" onClick={onOpenPalette}>
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('shell.tabs.split')} shortcut="mod+\">
          <IconButton label={t('shell.tabs.split')} size="sm" onClick={() => splitPane()}>
            <Columns2 className="size-3.5" />
          </IconButton>
        </Tooltip>
        {panesCount > 1 ? (
          <IconButton label="Закрыть панель" size="sm" onClick={() => closePane(pane.id)}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
      </div>
    </div>
  )
}

function TabChip({
  tab,
  active,
  onActivate,
  onDoubleClick,
  onClose,
  onDragStart,
}: {
  tab: TabState
  active: boolean
  onActivate: () => void
  onDoubleClick: () => void
  onClose: () => void
  onDragStart: (event: DragEvent) => void
}) {
  const t = useT()
  const pinTab = useWorkspace((s) => s.pinTab)
  const setTabGroup = useWorkspace((s) => s.setTabGroup)
  const closeOthers = useWorkspace((s) => s.closeOthers)
  const closeToRight = useWorkspace((s) => s.closeToRight)
  const splitPane = useWorkspace((s) => s.splitPane)

  return (
    <DropdownMenu>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        draggable
        onDragStart={onDragStart}
        onClick={onActivate}
        onDoubleClick={onDoubleClick}
        onAuxClick={(event) => {
          if (event.button === 1) onClose()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onActivate()
        }}
        className={cn(
          'group relative flex h-7 min-w-0 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-sm px-2',
          'text-sm transition-colors duration-[var(--duration-fast)]',
          active
            ? 'bg-surface text-fg shadow-sm'
            : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
          tab.pinned && 'max-w-[150px]',
        )}
      >
        {tab.group ? (
          <span
            aria-hidden
            className={cn(
              'h-3 w-0.5 shrink-0 rounded-full',
              GROUP_COLORS[tab.group] ?? 'bg-accent',
            )}
          />
        ) : null}
        <ObjectIcon
          type={tab.objectType ?? tab.icon ?? tab.screen ?? 'file'}
          className="size-3.5 shrink-0 text-fg-muted"
        />
        <span className={cn('min-w-0 flex-1 truncate', tab.preview && 'italic')}>{tab.title}</span>
        {tab.dirty ? (
          <span
            role="img"
            aria-label={t('shell.tabs.unsaved')}
            className="size-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : null}
        {!tab.pinned ? (
          <button
            type="button"
            aria-label={t('shell.tabs.close')}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-xs text-fg-muted',
              'opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg group-hover:opacity-100',
              active && 'opacity-60',
            )}
          >
            <X className="size-3" />
          </button>
        ) : (
          <Pin className="size-3 shrink-0 text-fg-muted" aria-hidden />
        )}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Меню вкладки"
            onClick={(event) => event.stopPropagation()}
            className="absolute inset-0 -z-10"
          />
        </DropdownMenuTrigger>
      </div>

      <DropdownMenuContent>
        <DropdownMenuItem icon={<Columns2 className="size-4" />} onSelect={() => splitPane(tab.id)}>
          {t('shell.tabs.split')}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={tab.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          onSelect={() => pinTab(tab.id, !tab.pinned)}
        >
          {tab.pinned ? t('shell.tabs.unpin') : t('shell.tabs.pin')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="flex gap-1 px-2 py-1.5">
          {Object.entries(GROUP_COLORS).map(([name, className]) => (
            <button
              key={name}
              type="button"
              aria-label={`Группа ${name}`}
              onClick={() => setTabGroup(tab.id, tab.group === name ? null : name)}
              className={cn(
                'size-4 rounded-full ring-offset-1 ring-offset-overlay',
                className,
                tab.group === name && 'ring-2 ring-accent',
              )}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => closeOthers(tab.id)}>
          {t('shell.tabs.closeOthers')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => closeToRight(tab.id)}>
          {t('shell.tabs.closeRight')}
        </DropdownMenuItem>
        <DropdownMenuItem danger onSelect={onClose} shortcut="⌘W">
          {t('shell.tabs.close')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
