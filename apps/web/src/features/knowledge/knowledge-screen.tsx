import type { PageTreeNode } from '@kchs/contracts'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  ObjectIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tree,
  type TreeNode,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { CreatePageDialog } from './create-page-dialog.js'
import { knowledgeSearchQuery, pageTreeQuery } from './queries.js'

/**
 * Раздел «Знания» (03-screens.md §18, ADR-0095): слева — дерево страниц
 * пространства с поиском по названию, справа — поиск по тексту страниц
 * (куски `page_chunk`, при подключённом источнике — и по смыслу).
 */
export function KnowledgeScreen({ spaceId: initial }: { spaceId?: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: spaces } = useQuery(spacesQuery())
  const [spaceId, setSpaceId] = useState(initial ?? '')
  const [treeSearch, setTreeSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const current = spaceId || spaces?.[0]?.id || ''
  const treeQuery = useDebouncedValue(treeSearch.trim(), 250)
  const { data: nodes, isLoading } = useQuery(pageTreeQuery(current, treeQuery))

  const tree = useMemo(() => toTree(nodes ?? []), [nodes])

  const open = (id: string, mode: 'preview' | 'permanent') => {
    const node = (nodes ?? []).find((item) => item.id === id)
    openTab({
      kind: 'object',
      objectId: id,
      objectType: 'page',
      title: node?.title ?? t('objects.types.page'),
      mode,
    })
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col gap-2 border-line border-r p-3">
        <Select value={current} onValueChange={setSpaceId}>
          <SelectTrigger aria-label={t('knowledge.navigator.space')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(spaces ?? []).map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={treeSearch}
          onChange={(event) => setTreeSearch(event.target.value)}
          placeholder={t('knowledge.navigator.searchPlaceholder')}
          aria-label={t('knowledge.navigator.searchPlaceholder')}
        />
        <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {selected ? t('knowledge.navigator.createChild') : t('knowledge.navigator.create')}
        </Button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <Skeleton className="h-40" />
          ) : tree.length === 0 ? (
            <EmptyState
              compact
              title={t('knowledge.navigator.empty')}
              description={t('knowledge.navigator.emptyHint')}
            />
          ) : (
            <Tree
              nodes={tree}
              selectedId={selected}
              expandedIds={expanded}
              onToggle={(id) =>
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onSelect={(node) => {
                setSelected(node.id)
                open(node.id, 'preview')
              }}
              onActivate={(node) => open(node.id, 'permanent')}
            />
          )}
        </div>
      </aside>
      <KnowledgeSearch spaceId={current} />
      {createOpen ? (
        <CreatePageDialog
          spaceId={current}
          parentId={selected}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </div>
  )
}

/** Плоский список узлов — в дерево; узел без видимого родителя идёт в корень. */
function toTree(nodes: PageTreeNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const node of nodes) {
    byId.set(node.id, {
      id: node.id,
      label: node.title,
      icon: <ObjectIcon type="page" />,
      children: [],
      hasChildren: node.hasChildren,
      badge: node.status === 'published' ? undefined : <StatusDot status={node.status} />,
    })
  }
  const roots: TreeNode[] = []
  for (const node of nodes) {
    const item = byId.get(node.id)
    if (!item) continue
    const parent = node.parentId ? byId.get(node.parentId) : null
    if (parent) parent.children?.push(item)
    else roots.push(item)
  }
  return roots
}

function StatusDot({ status }: { status: PageTreeNode['status'] }) {
  const t = useT()
  return (
    <Badge tone={status === 'review' ? 'warning' : 'neutral'}>
      {t(`knowledge.status.${status}`)}
    </Badge>
  )
}

/** Поиск по тексту страниц: куски с подсветкой, переход — к блоку страницы. */
function KnowledgeSearch({ spaceId }: { spaceId: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query.trim(), 250)
  const { data, isFetching } = useQuery(knowledgeSearchQuery(debounced, spaceId || null))

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
      aria-label={t('knowledge.search.title')}
    >
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('knowledge.search.placeholder')}
          aria-label={t('knowledge.search.title')}
          className="max-w-xl"
        />
        {data ? (
          <Badge tone="outline">
            {t(data.semantic ? 'knowledge.search.semantic' : 'knowledge.search.textOnly')}
          </Badge>
        ) : null}
      </div>

      {isFetching ? <Skeleton className="h-24" /> : null}
      {data && data.items.length === 0 && debounced.length > 1 ? (
        <EmptyState title={t('knowledge.search.empty')} />
      ) : null}

      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {(data?.items ?? []).map((hit) => (
          <li key={`${hit.pageId}-${hit.blockId ?? ''}-${hit.source}`}>
            <button
              type="button"
              className="w-full rounded-md border border-line bg-surface p-3 text-left hover:border-accent"
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: hit.pageId,
                  objectType: 'page',
                  title: hit.title,
                  mode: 'permanent',
                })
              }
            >
              <span className="flex items-center gap-2">
                <ObjectIcon type="page" />
                <span className="font-medium text-sm">{hit.title}</span>
                {hit.heading ? <span className="text-2xs text-fg-muted">{hit.heading}</span> : null}
                <span className="flex-1" />
                <Badge tone="outline">{t(`knowledge.search.source.${hit.source}`)}</Badge>
              </span>
              {/* Подсветка приходит с сервера уже экранированной (Meilisearch) */}
              <span
                className="mt-1 block text-xs text-fg-secondary [&_mark]:bg-warning-subtle [&_mark]:text-fg"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: сниппет экранирован на сервере
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
