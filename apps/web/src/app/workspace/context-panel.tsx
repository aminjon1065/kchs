import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  IconButton,
  KeyValueList,
  ObjectChip,
  ObjectIcon,
  Skeleton,
  Textarea,
  Tooltip,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity as ActivityIcon,
  Bot,
  ChevronsRight,
  Info,
  Link2,
  MessageSquare,
  Send,
  Star,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { http } from '~/shared/api/client.js'
import {
  discussionQuery,
  keys,
  objectAccessQuery,
  objectActivityQuery,
  objectLinksQuery,
  objectQuery,
} from '~/shared/api/queries.js'
import { useAppearance } from '../appearance.js'
import { useT } from '../i18n.js'
import { useWorkspace } from './store.js'
import type { ContextTabKey } from './types.js'

const TABS: Array<{ key: ContextTabKey; labelKey: string; icon: typeof Info }> = [
  { key: 'info', labelKey: 'shell.context.info', icon: Info },
  { key: 'links', labelKey: 'shell.context.links', icon: Link2 },
  { key: 'discussion', labelKey: 'shell.context.discussion', icon: MessageSquare },
  { key: 'activity', labelKey: 'shell.context.activity', icon: ActivityIcon },
  { key: 'assistant', labelKey: 'shell.context.assistant', icon: Bot },
]

export function ContextPanel() {
  const t = useT()
  const contextTab = useWorkspace((s) => s.contextTab)
  const setContextTab = useWorkspace((s) => s.setContextTab)
  const toggleContext = useWorkspace((s) => s.toggleContext)
  const tabs = useWorkspace((s) => s.tabs)
  const panes = useWorkspace((s) => s.panes)
  const focusedPaneId = useWorkspace((s) => s.focusedPaneId)

  const pane = panes.find((p) => p.id === focusedPaneId) ?? panes[0]
  const activeTab = pane?.activeTabId ? tabs[pane.activeTabId] : null
  const objectId = activeTab?.kind === 'object' ? activeTab.objectId : undefined

  return (
    <aside
      className="flex h-full w-(--context-w) shrink-0 flex-col border-l border-line bg-surface-2"
      aria-label={t('shell.context.title')}
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {TABS.map((item) => {
          const Icon = item.icon
          const disabled = item.key === 'assistant'
          return (
            <Tooltip key={item.key} content={t(item.labelKey)} delay={250}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setContextTab(item.key)}
                aria-label={t(item.labelKey)}
                aria-pressed={contextTab === item.key}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium',
                  'transition-colors duration-[var(--duration-fast)]',
                  contextTab === item.key
                    ? 'bg-surface text-fg shadow-sm'
                    : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
                  disabled && 'cursor-not-allowed opacity-40',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
              </button>
            </Tooltip>
          )
        })}
        <IconButton
          label={t('shell.context.collapse')}
          size="sm"
          className="ml-auto"
          onClick={() => toggleContext(false)}
        >
          <ChevronsRight className="size-3.5" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!objectId ? (
          <EmptyState
            compact
            icon={<Info />}
            title={t('shell.context.noObject')}
            description={t('shell.context.noObjectHint')}
          />
        ) : contextTab === 'info' ? (
          <InfoTab objectId={objectId} />
        ) : contextTab === 'links' ? (
          <LinksTab objectId={objectId} />
        ) : contextTab === 'discussion' ? (
          <DiscussionTab objectId={objectId} />
        ) : contextTab === 'activity' ? (
          <ActivityTab objectId={objectId} />
        ) : null}
      </div>
    </aside>
  )
}

function InfoTab({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const { data: object, isLoading } = useQuery(objectQuery(objectId))
  const { data: access } = useQuery(objectAccessQuery(objectId))

  const favorite = useMutation({
    mutationFn: async (next: boolean) => {
      if (next) await http.put(`/objects/${objectId}/favorite`)
      else await http.delete(`/objects/${objectId}/favorite`)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: keys.favorites })
    },
  })

  if (isLoading) return <PanelSkeleton />
  if (!object) return null

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-start gap-2.5">
        <ObjectIcon type={object.type} className="mt-0.5 size-5 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">{object.title}</div>
          <div className="mt-0.5 text-xs text-fg-muted">{t(`objects.types.${object.type}`)}</div>
        </div>
        <IconButton
          label={object.favorite ? t('objects.favorite.remove') : t('objects.favorite.add')}
          size="sm"
          active={object.favorite}
          onClick={() => favorite.mutate(!object.favorite)}
        >
          <Star className={cn('size-4', object.favorite && 'fill-current')} />
        </IconButton>
      </div>

      <KeyValueList
        items={[
          {
            key: 'level',
            label: t('access.share.level'),
            value: <Badge tone="accent">{t(`access.levels.${object.level}`)}</Badge>,
          },
          {
            key: 'space',
            label: t('common.labels.space'),
            value: object.spaceName ?? '—',
          },
          {
            key: 'created',
            label: t('common.labels.createdAt'),
            value: formatDateTime(object.createdAt, { locale }),
          },
          {
            key: 'updated',
            label: t('common.labels.updatedAt'),
            value: formatRelativeTime(object.updatedAt, { locale }),
          },
          {
            key: 'access',
            label: t('access.share.current'),
            value: access ? `${access.entries.length}` : '—',
          },
        ]}
      />

      {access?.entries.length ? (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            <Users className="size-3" aria-hidden />
            {t('access.share.current')}
          </div>
          <div className="flex flex-col gap-1">
            {access.entries.slice(0, 6).map((entry) => (
              <div
                key={`${entry.principal.type}:${entry.principal.id}`}
                className="flex items-center gap-2"
              >
                <Avatar name={entry.principal.title} src={entry.principal.avatarUrl} size="xs" />
                <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">
                  {entry.principal.title}
                </span>
                <Badge size="sm">{t(`access.levels.${entry.level}`)}</Badge>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LinksTab({ objectId }: { objectId: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(objectLinksQuery(objectId))

  if (isLoading) return <PanelSkeleton />
  type LinkGroup = NonNullable<typeof data>['links']
  const groups = new Map<string, LinkGroup>()
  for (const link of data?.links ?? []) {
    const list = groups.get(link.kind) ?? []
    list.push(link)
    groups.set(link.kind, list)
  }

  if (groups.size === 0 && !data?.uses.length && !data?.usedBy.length) {
    return <EmptyState compact icon={<Link2 />} title={t('objects.links.empty')} />
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      {[...groups.entries()].map(([kind, links]) => (
        <div key={kind}>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            {t(`objects.links.kind.${kind}`)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {links.map((link) => (
              <ObjectChip
                key={link.id}
                object={{ ...link.object, accessible: link.object.accessible }}
                onOpen={(obj) =>
                  openTab({
                    kind: 'object',
                    objectId: obj.id,
                    objectType: obj.type,
                    title: obj.title,
                    mode: 'preview',
                  })
                }
                onOpenInSplit={(obj) =>
                  openTab({
                    kind: 'object',
                    objectId: obj.id,
                    objectType: obj.type,
                    title: obj.title,
                    mode: 'split',
                  })
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function DiscussionTab({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const [draft, setDraft] = useState('')
  const { data, isLoading } = useQuery(discussionQuery(objectId))

  const post = useMutation({
    mutationFn: (text: string) =>
      http.post(`/objects/${objectId}/discussion/messages`, {
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        text,
        attachments: [],
        mentions: [],
        mentionedObjectIds: [],
      }),
    onSuccess: () => {
      setDraft('')
      void client.invalidateQueries({ queryKey: keys.discussion(objectId) })
      void client.invalidateQueries({ queryKey: keys.objectActivity(objectId) })
    },
  })

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <PanelSkeleton />
        ) : !data?.items.length ? (
          <EmptyState
            compact
            icon={<MessageSquare />}
            title={t('discussion.empty')}
            description={t('discussion.emptyHint')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {data.items.map((message) => (
              <article key={message.id} className="flex gap-2">
                <Avatar
                  name={message.author?.displayName ?? t('discussion.systemAuthor')}
                  src={message.author?.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-xs font-medium text-fg">
                      {message.author?.displayName ?? t('discussion.systemAuthor')}
                    </span>
                    <time className="shrink-0 text-2xs text-fg-muted" dateTime={message.createdAt}>
                      {formatRelativeTime(message.createdAt, { locale })}
                    </time>
                    {message.editedAt ? (
                      <span className="text-2xs text-fg-muted">{t('discussion.edited')}</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-secondary">
                    {message.kind === 'system' && message.systemKey
                      ? t(message.systemKey, message.systemParams as Record<string, string>)
                      : message.text}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line bg-surface p-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim()) post.mutate(draft.trim())
        }}
      >
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('discussion.placeholderComment')}
          className="min-h-[60px] text-sm"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && draft.trim()) {
              event.preventDefault()
              post.mutate(draft.trim())
            }
          }}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-2xs text-fg-muted">{t('discussion.sendHint')}</span>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={!draft.trim()}
            loading={post.isPending}
            icon={<Send className="size-3.5" />}
          >
            {t('discussion.send')}
          </Button>
        </div>
      </form>
    </div>
  )
}

function ActivityTab({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data, isLoading } = useQuery(objectActivityQuery(objectId))

  if (isLoading) return <PanelSkeleton />
  if (!data?.items.length) {
    return <EmptyState compact icon={<ActivityIcon />} title={t('objects.activity.empty')} />
  }

  return (
    <ol className="flex flex-col gap-0 p-3">
      {data.items.map((item, index) => (
        <li key={item.id} className="relative flex gap-2.5 pb-3">
          {index < data.items.length - 1 ? (
            <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-line" />
          ) : null}
          <span className="relative z-10 mt-1 size-3.5 shrink-0 rounded-full border-2 border-surface-2 bg-line-strong" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-fg-secondary">
              {t(item.summary.key, item.summary.params as Record<string, string>)}
            </p>
            <time className="text-2xs text-fg-muted" dateTime={item.occurredAt}>
              {formatRelativeTime(item.occurredAt, { locale })}
            </time>
          </div>
        </li>
      ))}
    </ol>
  )
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-3 w-52" />
    </div>
  )
}
