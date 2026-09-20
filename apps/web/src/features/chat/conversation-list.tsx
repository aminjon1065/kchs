import type { ChatListItem, ChatSection, PresenceStatus } from '@kchs/contracts'
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  ObjectIcon,
  SearchInput,
  Skeleton,
  useDebouncedValue,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Hash, Lock, MessageSquare, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { chatDraftsQuery, chatListQuery, peersPresenceQuery } from './queries.js'

const SECTIONS: ChatSection[] = [
  'all',
  'unread',
  'pinned',
  'direct',
  'channels',
  'discussions',
  'discover',
]

/** Точка присутствия у аватара: «на встрече» и «не беспокоить» показываются одинаково. */
function dotOf(status: PresenceStatus | undefined): 'online' | 'away' | 'dnd' | null {
  if (status === 'online') return 'online'
  if (status === 'away') return 'away'
  if (status === 'dnd' || status === 'in_meeting') return 'dnd'
  return null
}

function Icon({ item }: { item: ChatListItem }) {
  if (item.kind === 'direct') {
    return null
  }
  if (item.kind === 'object') {
    return <ObjectIcon type={item.objectType ?? 'conversation'} className="size-4 text-fg-muted" />
  }
  if (item.kind === 'channel') {
    return item.privacy === 'open' ? (
      <Hash className="size-4 text-fg-muted" />
    ) : (
      <Lock className="size-4 text-fg-muted" />
    )
  }
  return <MessageSquare className="size-4 text-fg-muted" />
}

/**
 * Список бесед (P4-E01 S02): разделы, поиск, закреплённые сверху, счётчики
 * непрочитанного и пометка черновика.
 */
export function ConversationList({
  section,
  onSection,
  selectedId,
  onSelect,
  onCreate,
  full = false,
}: {
  section: ChatSection
  onSection: (section: ChatSection) => void
  selectedId: string | null
  onSelect: (item: ChatListItem) => void
  onCreate: () => void
  /** Мобильный веб: список — единственная панель и занимает экран целиком. */
  full?: boolean
}) {
  const t = useT()
  const [search, setSearch] = useState('')
  const needle = useDebouncedValue(search.trim().toLowerCase(), 200)
  const { data, isLoading } = useQuery(chatListQuery(section))
  const { data: drafts } = useQuery(chatDraftsQuery())

  const items = useMemo(
    () =>
      (data?.items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle)),
    [data?.items, needle],
  )
  const peerIds = useMemo(
    () => [...new Set(items.flatMap((item) => (item.peer ? [item.peer.id] : [])))].sort(),
    [items],
  )
  const { data: presence } = useQuery(peersPresenceQuery(peerIds))
  const statuses = useMemo(
    () => new Map((presence?.items ?? []).map((state) => [state.userId, state.status])),
    [presence?.items],
  )
  const withDraft = useMemo(
    () => new Set((drafts?.items ?? []).map((draft) => draft.conversationId)),
    [drafts?.items],
  )

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col bg-surface-2',
        full ? 'w-full flex-1' : 'w-72 shrink-0 border-r border-line',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-line p-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          aria-label={t('chats.findChat')}
          placeholder={t('chats.findChat')}
          className="h-8 flex-1 text-sm"
        />
        <Button
          size="sm"
          variant="primary"
          onClick={onCreate}
          icon={<Plus className="size-3.5" />}
          aria-label={t('chats.newChat')}
        >
          {t('chats.newChat')}
        </Button>
      </div>

      <div
        role="tablist"
        aria-label={t('chats.title')}
        className="flex shrink-0 flex-wrap gap-1 border-b border-line px-2 py-1.5"
      >
        {SECTIONS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === section}
            onClick={() => onSection(key)}
            className={cn(
              'rounded-full px-2 py-0.5 text-2xs',
              key === section
                ? 'bg-accent text-accent-fg'
                : 'bg-surface text-fg-secondary hover:bg-surface-3',
            )}
          >
            {t(`chats.sections.${key}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon={<MessageSquare className="size-5" />}
            title={t('chats.empty')}
            description={t('chats.emptyHint')}
          />
        ) : (
          <ul aria-label={t('chats.title')} className="flex flex-col p-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === selectedId}
                  onClick={() => onSelect(item)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                    item.id === selectedId ? 'bg-accent-subtle' : 'hover:bg-surface-3',
                  )}
                >
                  {item.peer ? (
                    <Avatar
                      name={item.peer.displayName}
                      src={item.peer.avatarUrl}
                      size="sm"
                      status={dotOf(statuses.get(item.peer.id))}
                    />
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3">
                      <Icon item={item} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.title}</span>
                      {item.unreadCount > 0 ? (
                        <Badge
                          tone={item.unreadMentions > 0 ? 'danger' : 'accent'}
                          size="sm"
                          aria-label={t('chats.unreadBadge', { count: item.unreadCount })}
                        >
                          {item.unreadCount > 99 ? '99+' : item.unreadCount}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-2xs text-fg-muted">
                      {withDraft.has(item.id) ? (
                        <span className="shrink-0 text-accent">{t('chats.draft')}</span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">
                        {item.lastMessage?.text || item.spaceName || ''}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
