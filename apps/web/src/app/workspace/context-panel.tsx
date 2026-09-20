import { atLeast, type ObjectRecord, type TagView } from '@kchs/contracts'
import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  FileDropzone,
  IconButton,
  KeyValueList,
  ObjectChip,
  ObjectIcon,
  ProgressBar,
  Skeleton,
  TagInput,
  Tooltip,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity as ActivityIcon,
  Bot,
  ChevronsRight,
  Info,
  Link2,
  MessageSquare,
  Star,
  Tag as TagIcon,
  Users,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { type ComposedMessage, MessageComposer } from '~/features/discussion/message-composer.js'
import { MessageItem } from '~/features/discussion/message-item.js'
import { uploadFile } from '~/features/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import {
  discussionQuery,
  keys,
  objectAccessQuery,
  objectActivityQuery,
  objectLinksQuery,
  objectQuery,
  tagSuggestionsQuery,
} from '~/shared/api/queries.js'
import { useAppearance } from '../appearance.js'
import { useT } from '../i18n.js'
import { getObjectView } from './registry.js'
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
  const assistant = activeTab?.objectType
    ? getObjectView(activeTab.objectType)?.assistantSection
    : undefined

  return (
    <aside
      className="flex h-full w-(--context-w) shrink-0 flex-col border-l border-line bg-surface-2"
      aria-label={t('shell.context.title')}
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {TABS.map((item) => {
          const Icon = item.icon
          const disabled = item.key === 'assistant' && !assistant
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
        ) : contextTab === 'assistant' ? (
          assistant ? (
            assistant(objectId)
          ) : (
            <EmptyState compact icon={<Bot />} title={t('shell.context.assistantUnavailable')} />
          )
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
      {getObjectView(object.type)?.contextSection?.(objectId)}
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

      <ObjectTags object={object} />

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

/** Теги объекта: читатель видит, редактор назначает и снимает (02-platform-kernel.md §14). */
function ObjectTags({ object }: { object: ObjectRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 150)
  const editable = atLeast(object.level, 'edit')
  const { data: suggestions = [] } = useQuery({
    ...tagSuggestionsQuery(object.spaceId, debounced),
    enabled: editable,
  })

  const apply = (items: TagView[]) => {
    client.setQueryData<ObjectRecord>(keys.object(object.id), (current) =>
      current ? { ...current, tags: items } : current,
    )
    void client.invalidateQueries({ queryKey: ['tags'] })
  }
  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('errors.unknown'))

  const add = useMutation({
    mutationFn: (name: string) =>
      http.post<{ items: TagView[] }>(`/objects/${object.id}/tags`, { name }),
    onSuccess: (data) => apply(data.items),
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: (tagId: string) =>
      http.delete<{ items: TagView[] }>(`/objects/${object.id}/tags/${tagId}`),
    onSuccess: (data) => apply(data.items),
    onError: failed,
  })

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
        <TagIcon className="size-3" aria-hidden />
        {t('common.labels.tags')}
      </div>
      <TagInput
        value={object.tags}
        suggestions={suggestions}
        onQueryChange={setQuery}
        onAdd={(name) => add.mutate(name)}
        onRemove={(tag) => remove.mutate(tag.id)}
        readOnly={!editable}
        aria-label={t('common.labels.tags')}
      />
    </div>
  )
}

function LinksTab({ objectId }: { objectId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(objectLinksQuery(objectId))
  const { data: object } = useQuery(objectQuery(objectId))
  const [uploads, setUploads] = useState<Record<string, { name: string; progress: number }>>({})

  // Вложения (09-files.md §1): прикрепляет тот, кто вправе изменять объект
  const canAttach = Boolean(object?.spaceId && atLeast(object.level, 'edit'))

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.objectLinks(objectId) })
    void client.invalidateQueries({ queryKey: keys.objectActivity(objectId) })
  }

  const attach = async (files: File[]) => {
    const spaceId = object?.spaceId
    if (!spaceId) return
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`
      setUploads((current) => ({ ...current, [key]: { name: file.name, progress: 0 } }))
      try {
        await uploadFile({
          file,
          spaceId,
          attachToObjectId: objectId,
          onProgress: (progress) =>
            setUploads((current) => ({ ...current, [key]: { name: file.name, progress } })),
        })
        toast.show({
          title: t('objects.attachments.attached', { name: file.name }),
          tone: 'success',
        })
      } catch {
        toast.error(t('objects.attachments.failed', { name: file.name }))
      } finally {
        setUploads((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        refresh()
      }
    }
  }

  const detach = useMutation({
    mutationFn: (fileId: string) => http.delete(`/objects/${objectId}/links/${fileId}/attachment`),
    onSuccess: () => {
      toast.show({ title: t('objects.attachments.detached'), tone: 'success' })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  if (isLoading) return <PanelSkeleton />
  type LinkGroup = NonNullable<typeof data>['links']
  const groups = new Map<string, LinkGroup>()
  for (const link of data?.links ?? []) {
    const list = groups.get(link.kind) ?? []
    list.push(link)
    groups.set(link.kind, list)
  }
  const empty = groups.size === 0 && !data?.uses.length && !data?.usedBy.length

  return (
    <div className="flex flex-col gap-4 p-3">
      {canAttach ? (
        <div className="flex flex-col gap-1.5">
          <FileDropzone
            compact
            onFiles={(files) => void attach(files)}
            label={t('objects.attachments.drop')}
          />
          {Object.entries(uploads).map(([key, upload]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-2xs text-fg-secondary">
                {upload.name}
              </span>
              <ProgressBar value={upload.progress} className="w-24" />
            </div>
          ))}
        </div>
      ) : null}
      {empty ? <EmptyState compact icon={<Link2 />} title={t('objects.links.empty')} /> : null}
      {[...groups.entries()].map(([kind, links]) => (
        <div key={kind}>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-fg-muted">
            {t(`objects.links.kind.${kind}`)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {links.map((link) => (
              <span key={link.id} className="inline-flex max-w-full items-center gap-0.5">
                <ObjectChip
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
                {kind === 'attachment' && link.direction === 'outgoing' && canAttach ? (
                  <IconButton
                    size="sm"
                    label={t('objects.attachments.detach')}
                    onClick={() => detach.mutate(link.object.id)}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Обсуждение объекта; с якорем (`discussionAnchor`) — комментарии к фрагменту:
 * у страницы базы знаний это блок (ADR-0095). Новый комментарий получает тот
 * же якорь, кнопка «Ко всему объекту» его снимает.
 */
function DiscussionTab({ objectId }: { objectId: string }) {
  const t = useT()
  const client = useQueryClient()
  const anchor = useWorkspace((s) => s.discussionAnchor)
  const setContextTab = useWorkspace((s) => s.setContextTab)
  const { data, isLoading } = useQuery(discussionQuery(objectId))
  const { data: object } = useQuery(objectQuery(objectId))
  // Писать и реагировать может уровень comment и выше — сервер проверяет сам
  const canPost = object ? object.level !== 'view' : false
  const items = anchor
    ? (data?.items ?? []).filter((message) => message.anchor === anchor)
    : (data?.items ?? [])

  const post = useMutation({
    mutationFn: (message: ComposedMessage) =>
      http.post(`/objects/${objectId}/discussion/messages`, {
        body: message.body,
        text: message.text,
        attachments: message.attachments.map((fileId) => ({ fileId })),
        mentions: message.mentions,
        mentionedObjectIds: [],
        anchor,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.discussion(objectId) })
      void client.invalidateQueries({ queryKey: keys.objectActivity(objectId) })
      void client.invalidateQueries({ queryKey: keys.objectLinks(objectId) })
    },
  })

  // Вложение сообщения — вложение объекта: лежит в папке «Вложения» его пространства
  const attach = async (file: File) => {
    if (!object?.spaceId) throw new Error(t('errors.unknown'))
    const created = await uploadFile({ file, spaceId: object.spaceId, attachToObjectId: objectId })
    return { id: created.id, name: file.name, size: file.size }
  }

  return (
    <div className="flex h-full flex-col">
      {anchor ? (
        <div className="flex items-center gap-2 border-line border-b px-3 py-2">
          <span className="text-2xs text-fg-muted">{t('discussion.anchored')}</span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setContextTab('discussion', null)}>
            {t('discussion.wholeObject')}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <PanelSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon={<MessageSquare />}
            title={t(anchor ? 'discussion.anchorEmpty' : 'discussion.empty')}
            description={t('discussion.emptyHint')}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                objectId={objectId}
                canReact={canPost}
              />
            ))}
          </div>
        )}
      </div>

      {canPost ? (
        <MessageComposer
          onSend={(message) => post.mutateAsync(message)}
          onAttach={attach}
          pending={post.isPending}
          placeholder={t('discussion.placeholderComment')}
        />
      ) : null}
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
