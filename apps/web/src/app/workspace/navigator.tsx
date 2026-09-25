import type { ObjectSummary, Space } from '@kchs/contracts'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  IconButton,
  ObjectIcon,
  SearchInput,
  Tooltip,
  Tree,
  type TreeNode,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ChevronsLeft, Clock, LayoutGrid, Plus, Star, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { favoritesQuery, objectListQuery, recentQuery, spacesQuery } from '~/shared/api/queries.js'
import { useT } from '../i18n.js'
import { getScreen } from './registry.js'
import { useWorkspace } from './store.js'

const SPACE_KIND_ORDER: Record<string, number> = { org: 0, unit: 1, team: 2, personal: 3 }

export function Navigator({ onCreateSpace }: { onCreateSpace: () => void }) {
  const t = useT()
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const openTab = useWorkspace((s) => s.openTab)
  const toggleNavigator = useWorkspace((s) => s.toggleNavigator)
  const navigatorModule = useWorkspace((s) => s.navigatorModule)

  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: favorites = [] } = useQuery(favoritesQuery())
  const { data: recent = [] } = useQuery(recentQuery())

  const expandedSpaceId = useMemo(
    () => [...expanded].find((id) => spaces.some((space) => space.id === id)) ?? null,
    [expanded, spaces],
  )

  const { data: children } = useQuery({
    ...objectListQuery({ spaceId: expandedSpaceId ?? '', limit: 100 }),
    enabled: Boolean(expandedSpaceId),
  })

  const nodes = useMemo<TreeNode[]>(() => {
    const visible = spaces
      .filter((space) => !filter || space.name.toLowerCase().includes(filter.toLowerCase()))
      .sort(
        (a, b) =>
          (SPACE_KIND_ORDER[a.kind] ?? 9) - (SPACE_KIND_ORDER[b.kind] ?? 9) ||
          a.name.localeCompare(b.name, 'ru'),
      )

    return visible.map((space) => ({
      id: space.id,
      label: space.name,
      icon: <ObjectIcon type="space" className="text-fg-muted" />,
      hasChildren: true,
      badge:
        space.kind === 'personal' ? (
          <span className="text-2xs text-fg-muted">{t('spaces.kinds.personal')}</span>
        ) : null,
      children:
        expandedSpaceId === space.id
          ? (children?.items ?? []).filter((item) => !item.meta?.parentId).map(toNode)
          : undefined,
    }))
  }, [spaces, filter, expandedSpaceId, children, t])

  const openObject = (
    summary: { id: string; type: string; title: string },
    permanent = false,
  ): void => {
    setSelectedId(summary.id)
    openTab({
      kind: 'object',
      objectId: summary.id,
      objectType: summary.type,
      title: summary.title,
      mode: permanent ? 'permanent' : 'preview',
    })
  }

  return (
    <aside
      className="flex h-full w-(--navigator-w) shrink-0 flex-col border-r border-line bg-surface-2"
      aria-label={t('shell.navigator.title')}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex-1 truncate text-xs font-semibold text-fg">
          {/* Заголовок — названия экрана из реестра: палитра открывает и экраны без
              кнопки на рейке (корзина, контроль, SQL), у них нет подписи shell.rail.* */}
          {t(getScreen(navigatorModule)?.titleKey ?? `shell.rail.${navigatorModule}`)}
        </span>
        <Tooltip content={t('shell.navigator.collapse')} shortcut="mod+b">
          <IconButton
            label={t('shell.navigator.collapse')}
            size="sm"
            onClick={() => toggleNavigator(false)}
          >
            <ChevronsLeft className="size-3.5" />
          </IconButton>
        </Tooltip>
      </div>

      <div className="shrink-0 p-2">
        <SearchInput
          value={filter}
          onValueChange={setFilter}
          placeholder={t('shell.navigator.search')}
          className="h-7"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {favorites.length > 0 ? (
          <Section
            title={t('shell.navigator.favorites')}
            icon={<Star className="size-3" />}
            defaultOpen
          >
            {favorites.slice(0, 10).map((item) => (
              <NavItem
                key={item.id}
                item={item}
                onOpen={openObject}
                selected={selectedId === item.id}
              />
            ))}
          </Section>
        ) : null}

        <Section
          title={t('shell.navigator.spaces')}
          icon={<LayoutGrid className="size-3" />}
          defaultOpen
        >
          <Tree
            nodes={nodes}
            selectedId={selectedId}
            expandedIds={expanded}
            onToggle={(id) => {
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else {
                  next.clear()
                  next.add(id)
                }
                return next
              })
            }}
            onSelect={(node) => {
              const space = spaces.find((s) => s.id === node.id)
              if (space) {
                setSelectedId(space.id)
                openSpace(space, openTab, false)
                return
              }
              const summary = (children?.items ?? []).find((item) => item.id === node.id)
              if (summary) openObject(summary)
            }}
            onActivate={(node) => {
              const space = spaces.find((s) => s.id === node.id)
              if (space) {
                openSpace(space, openTab, true)
                return
              }
              const summary = (children?.items ?? []).find((item) => item.id === node.id)
              if (summary) openObject(summary, true)
            }}
            emptyState={t('shell.navigator.empty')}
          />
        </Section>

        {recent.length > 0 ? (
          <Section title={t('shell.navigator.recent')} icon={<Clock className="size-3" />}>
            {recent.slice(0, 8).map((item) => (
              <NavItem
                key={item.id}
                item={item}
                onOpen={openObject}
                selected={selectedId === item.id}
              />
            ))}
          </Section>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-line p-2">
        <Button
          variant="secondary"
          size="sm"
          block
          icon={<Plus className="size-3.5" />}
          onClick={onCreateSpace}
        >
          {t('shell.navigator.newSpace')}
        </Button>
        <Tooltip content={t('objects.trash.title')}>
          <IconButton
            label={t('objects.trash.title')}
            size="md"
            onClick={() =>
              openTab({
                kind: 'screen',
                screen: 'trash',
                title: t('objects.trash.title'),
                icon: 'folder',
                mode: 'permanent',
              })
            }
          >
            <Trash2 className="size-4" />
          </IconButton>
        </Tooltip>
      </div>
    </aside>
  )
}

function openSpace(
  space: Space,
  openTab: ReturnType<typeof useWorkspace.getState>['openTab'],
  permanent: boolean,
): void {
  openTab({
    kind: 'screen',
    screen: 'space',
    title: space.name,
    icon: 'space',
    params: { spaceId: space.id },
    mode: permanent ? 'permanent' : 'preview',
  })
}

function toNode(summary: ObjectSummary): TreeNode {
  return {
    id: summary.id,
    label: summary.title,
    icon: <ObjectIcon type={summary.type} className="text-fg-muted" />,
    hasChildren: summary.type === 'folder',
  }
}

function Section({
  title,
  icon,
  children,
  defaultOpen,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1">
      <CollapsibleTrigger>
        {icon}
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-0.5">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function NavItem({
  item,
  onOpen,
  selected,
}: {
  item: ObjectSummary
  onOpen: (summary: { id: string; type: string; title: string }, permanent?: boolean) => void
  selected: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      onDoubleClick={() => onOpen(item, true)}
      className={cn(
        'flex h-7 w-full items-center gap-1.5 rounded-sm px-1.5 text-sm',
        selected
          ? 'bg-accent-subtle text-accent'
          : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
      )}
    >
      <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
    </button>
  )
}
