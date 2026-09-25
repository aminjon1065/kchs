import type { ChatListItem, Message, TranslateResult } from '@kchs/contracts'
import {
  Badge,
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  SearchInput,
  Skeleton,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  BellOff,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronLeft,
  Languages,
  Link2,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  Pin,
  Search,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { aiStatusQuery } from '~/features/data/queries.js'
import { MessageComposer } from '~/features/discussion/message-composer.js'
import {
  DeleteMessageDialog,
  MessageItem,
  MessageMenu,
} from '~/features/discussion/message-item.js'
import { uploadFile } from '~/features/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import { emitTyping, onRealtimeEvent } from '~/shared/realtime/client.js'
import {
  AttachDialog,
  ForwardDialog,
  InviteDialog,
  MessageTaskDialog,
  RenameDialog,
} from './chat-dialogs.js'
import {
  chatKeys,
  chatMembersQuery,
  chatMessagesQuery,
  chatPinsQuery,
  chatSearchQuery,
} from './queries.js'

/** Сколько держится «печатает» после последнего сигнала соседа. */
const TYPING_TTL_MS = 5_000
/** Свой сигнал «печатает» — не чаще раза за этот промежуток. */
const TYPING_EVERY_MS = 3_000
/** Столько сообщений пересылается за раз (ChatForwardInput). */
const FORWARD_LIMIT = 20

/** Разделитель дня: сегодня, вчера или дата. */
function dayLabel(iso: string, locale: string, t: (key: string) => string): string {
  const date = new Date(iso)
  const today = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(date, today)) return t('chats.today')
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (sameDay(date, yesterday)) return t('chats.yesterday')
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
  }).format(date)
}

type Dialog =
  | { kind: 'task'; messageId: string; text: string }
  | { kind: 'attach'; messageId: string }
  | { kind: 'forward'; messageIds: string[] }
  | { kind: 'delete'; messageId: string }
  | { kind: 'invite' }
  | { kind: 'rename' }
  | null

/**
 * Кто печатает в беседе — по сигналам `typing` шлюза (ADR-0161); каждый гаснет
 * через `TYPING_TTL_MS`, если сигнал не повторился.
 */
function useTyping(conversationId: string, myId: string | null): string[] {
  const [typers, setTypers] = useState<Record<string, { name: string; until: number }>>({})
  useEffect(() => {
    setTypers({})
    const off = onRealtimeEvent('typing', (payload) => {
      const {
        conversationId: from,
        userId,
        displayName,
      } = payload as {
        conversationId?: string
        userId?: string
        displayName?: string
      }
      // Свой сигнал с другой вкладки — не «кто-то печатает»
      if (from !== conversationId || !userId || userId === myId) return
      setTypers((current) => ({
        ...current,
        [userId]: { name: displayName ?? '', until: Date.now() + TYPING_TTL_MS },
      }))
    })
    const timer = window.setInterval(() => {
      setTypers((current) => {
        const now = Date.now()
        const alive = Object.entries(current).filter(([, typer]) => typer.until > now)
        return alive.length === Object.keys(current).length ? current : Object.fromEntries(alive)
      })
    }, 1_000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [conversationId, myId])
  return Object.values(typers).map((typer) => typer.name)
}

function typingLabel(
  names: string[],
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (names.length === 0) return null
  if (names.length === 1) return t('discussion.typing', { name: names[0] ?? '' })
  if (names.length === 2) {
    return t('chats.typingTwo', { first: names[0] ?? '', second: names[1] ?? '' })
  }
  return t('chats.typingMany', { count: names.length })
}

/**
 * Отметка своего сообщения (ADR-0161): в личной беседе ✓ — доставлено, ✓✓ —
 * собеседник прочитал; в группе и канале ✓✓ с числом прочитавших.
 */
function Receipt({ direct, readers }: { direct: boolean; readers: number }) {
  const t = useT()
  const label =
    readers === 0
      ? t('chats.receipt.sent')
      : direct
        ? t('chats.receipt.read')
        : t('chats.receipt.readBy', { count: readers })
  const Icon = readers > 0 ? CheckCheck : Check
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-2xs',
        readers > 0 ? 'text-accent' : 'text-fg-muted',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {!direct && readers > 0 ? (
        <span className="tabular" aria-hidden>
          {readers}
        </span>
      ) : null}
    </span>
  )
}

/**
 * Лента беседы (P4-E01 S02): шапка с участниками, звонком, поиском и
 * закреплениями, сообщения с разделителями дней и чертой «непрочитанные»,
 * действия из сообщения и композер с `/`-командами.
 */
export function MessageFeed({
  conversation,
  threadRootId,
  onThread,
  onOpenMeeting,
  onBack,
}: {
  conversation: ChatListItem
  threadRootId: string | null
  onThread: (messageId: string | null) => void
  onOpenMeeting: (meetingId: string) => void
  /** Мобильный веб: возврат к списку бесед — панель здесь одна. */
  onBack?: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const [limit, setLimit] = useState(50)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [searching, setSearching] = useState(false)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Перевод сообщения (ADR-0100): показывается под оригиналом, никуда не пишется
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const needle = useDebouncedValue(search.trim(), 250)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Выбор сообщений для пересылки: null — обычный режим ленты
  const [selected, setSelected] = useState<string[] | null>(null)
  const typingSentRef = useRef(0)
  // Отметки прочтения — в беседах с участниками; у обсуждения объекта их нет
  const receiptsOn = conversation.kind !== 'object'

  const { data, isLoading } = useQuery(chatMessagesQuery(conversation.id, null, limit))
  const { data: ai } = useQuery(aiStatusQuery())
  const { data: pins } = useQuery(chatPinsQuery(pinsOpen ? conversation.id : null))
  const { data: found } = useQuery(chatSearchQuery(searching ? needle : '', conversation.id))
  const { data: me } = useQuery(meQuery())
  const { data: members } = useQuery(chatMembersQuery(receiptsOn ? conversation.id : null))
  const myId = me?.user.id ?? null
  const typing = typingLabel(useTyping(conversation.id, myId), t)

  const messages = data?.items ?? []
  const lastId = messages.at(-1)?.id ?? null
  const unreadFrom = conversation.firstUnreadMessageId

  // Докуда дочитали остальные участники
  const readUpTo = useMemo(
    () =>
      (members?.items ?? []).flatMap((member) =>
        member.user.id !== myId && member.lastReadMessageId
          ? [Number(member.lastReadMessageId)]
          : [],
      ),
    [members, myId],
  )
  const receiptOf = (message: Message) => {
    if (!receiptsOn || !myId || message.author?.id !== myId || message.kind !== 'user') return null
    const readers = readUpTo.filter((position) => position >= Number(message.id)).length
    return <Receipt direct={conversation.kind === 'direct'} readers={readers} />
  }

  // Прочтения в оживлённой беседе приходят пачкой — участники перечитываются
  // не чаще раза в секунду
  useEffect(() => {
    if (!receiptsOn) return
    let timer: number | undefined
    const off = onRealtimeEvent('message.read', (payload) => {
      if ((payload as { conversationId?: string }).conversationId !== conversation.id) return
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        void client.invalidateQueries({ queryKey: chatKeys.members(conversation.id) })
      }, 1_000)
    })
    return () => {
      off()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [conversation.id, receiptsOn, client])

  const toggleSelected = (messageId: string) =>
    setSelected((current) => {
      const list = current ?? []
      if (list.includes(messageId)) return list.filter((id) => id !== messageId)
      return list.length >= FORWARD_LIMIT ? list : [...list, messageId]
    })

  // Отметка прочтения — когда лента показана и внизу есть новое сообщение
  const markRead = useMutation({
    mutationFn: (messageId: string) =>
      http.post(`/conversations/${conversation.id}/read`, { messageId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.all }),
  })
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!lastId || markedRef.current === lastId || conversation.unreadCount === 0) return
    markedRef.current = lastId
    markRead.mutate(lastId)
  }, [lastId, conversation.unreadCount, markRead.mutate])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [])

  const saveDraft = useMutation({
    mutationFn: (text: string) =>
      http.put(`/chats/${conversation.id}/draft`, {
        threadRootId: null,
        body: text ? { type: 'doc', content: [] } : null,
        text,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.drafts }),
  })

  const translate = useMutation({
    mutationFn: async (input: { messageId: string; text: string }) => ({
      messageId: input.messageId,
      result: await http.post<TranslateResult>('/ai/translate', {
        text: input.text,
        to: locale,
      }),
    }),
    onSuccess: ({ messageId, result }) =>
      setTranslations((current) => ({ ...current, [messageId]: result.text })),
    onError: () => toast.error(t('chats.translateFailed')),
  })

  const post = useMutation({
    mutationFn: (message: {
      body: unknown
      text: string
      mentions: string[]
      attachments: string[]
    }) =>
      http.post(`/conversations/${conversation.id}/messages`, {
        body: message.body,
        text: message.text,
        attachments: message.attachments.map((fileId) => ({ fileId })),
        mentions: message.mentions,
        mentionedObjectIds: [],
        ...(threadRootId ? { threadRootId } : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.discussion(conversation.id) })
      void client.invalidateQueries({ queryKey: chatKeys.all })
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
    },
  })

  const call = useMutation({
    mutationFn: () => http.post<{ meetingId: string }>(`/chats/${conversation.id}/call`, {}),
    onSuccess: (result) => {
      toast.show({ title: t('chats.callStarted') })
      onOpenMeeting(result.meetingId)
      void client.invalidateQueries({ queryKey: keys.discussion(conversation.id) })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const settings = useMutation({
    mutationFn: (patch: { pinned?: boolean; muted?: boolean; archived?: boolean }) =>
      http.put(`/chats/${conversation.id}/settings`, patch),
    onSuccess: (_, patch) => {
      void client.invalidateQueries({ queryKey: chatKeys.all })
      if (patch.archived)
        toast.show({ title: t('chats.archivedDone'), description: t('chats.archiveHint') })
    },
  })

  const pin = useMutation({
    mutationFn: (input: { messageId: string; on: boolean }) =>
      http.put(`/chats/${conversation.id}/pins`, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.pins(conversation.id) }),
  })

  const leave = useMutation({
    mutationFn: () => http.post(`/chats/${conversation.id}/leave`, {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.all }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const join = useMutation({
    mutationFn: () => http.post(`/chats/${conversation.id}/join`, {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: chatKeys.all }),
  })

  /** `/`-команды композера: `/task` — поручение, `/meet` — звонок. */
  const command = (text: string): boolean => {
    const match = /^\/(task|meet)\b\s*(.*)$/s.exec(text.trim())
    if (!match) return false
    if (match[1] === 'meet') {
      call.mutate()
      return true
    }
    setDialog({ kind: 'task', messageId: lastId ?? '', text: match[2] ?? '' })
    return true
  }

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = []
    for (const message of messages) {
      const day = dayLabel(message.createdAt, locale, t)
      const last = out.at(-1)
      if (last && last.day === day) last.items.push(message)
      else out.push({ day, items: [message] })
    }
    return out
  }, [messages, locale, t])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        {onBack ? (
          <IconButton size="sm" label={t('common.actions.back')} onClick={onBack}>
            <ChevronLeft className="size-4" />
          </IconButton>
        ) : null}
        <h2 className="min-w-0 truncate text-sm font-medium text-fg">{conversation.title}</h2>
        <Badge tone="neutral" size="sm">
          <Users className="mr-1 size-3" aria-hidden />
          {t('chats.members', { count: conversation.memberCount })}
        </Badge>
        {conversation.muted ? (
          <BellOff className="size-3.5 text-fg-muted" aria-label={t('chats.mute')} />
        ) : null}
        {conversation.archived ? (
          <Badge tone="neutral" size="sm">
            <Archive className="mr-1 size-3" aria-hidden />
            {t('chats.inArchive')}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            size="sm"
            label={t('chats.findMessages')}
            onClick={() => setSearching((open) => !open)}
          >
            <Search className="size-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            label={t('chats.pinnedTitle')}
            onClick={() => setPinsOpen((open) => !open)}
          >
            <Pin className="size-3.5" />
          </IconButton>
          {conversation.can.post ? (
            <IconButton size="sm" label={t('chats.call')} onClick={() => call.mutate()}>
              <Phone className="size-3.5" />
            </IconButton>
          ) : null}
          {conversation.can.join ? (
            <Button size="sm" variant="primary" onClick={() => join.mutate()}>
              {t('chats.join')}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={t('chats.actions')}>
                <MoreHorizontal className="size-3.5" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => settings.mutate({ pinned: !conversation.pinned })}>
                {t(conversation.pinned ? 'chats.unpinChat' : 'chats.pinChat')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => settings.mutate({ muted: !conversation.muted })}>
                {t(conversation.muted ? 'chats.unmute' : 'chats.mute')}
              </DropdownMenuItem>
              {conversation.member || conversation.kind === 'object' ? (
                <DropdownMenuItem
                  onSelect={() => settings.mutate({ archived: !conversation.archived })}
                >
                  {t(conversation.archived ? 'chats.unarchive' : 'chats.archive')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => setSelected([])}>
                {t('chats.selectMany')}
              </DropdownMenuItem>
              {conversation.can.manage ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDialog({ kind: 'rename' })}>
                    {t('chats.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ kind: 'invite' })}>
                    {t('chats.invite')}
                  </DropdownMenuItem>
                </>
              ) : null}
              {conversation.can.leave ? (
                <DropdownMenuItem onSelect={() => leave.mutate()}>
                  {t('chats.leave')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {searching ? (
        <div className="shrink-0 border-b border-line bg-surface-2 p-2">
          <SearchInput
            value={search}
            autoFocus
            onValueChange={setSearch}
            aria-label={t('chats.findMessages')}
            placeholder={t('chats.findPlaceholder')}
            className="h-8 text-sm"
          />
          {needle.length >= 2 ? (
            <ul aria-label={t('chats.findMessages')} className="mt-2 flex flex-col gap-1">
              <li className="text-2xs text-fg-muted">
                {t('chats.found', { count: found?.hits.length ?? 0 })}
              </li>
              {(found?.hits ?? []).map((hit) => (
                <li
                  key={hit.messageId}
                  className="rounded-sm border border-line bg-surface px-2 py-1 text-xs text-fg-secondary"
                >
                  <span className="mr-1 text-fg">{hit.author?.displayName ?? ''}</span>
                  {/* biome-ignore lint/security/noDangerouslySetInnerHtml: подсветка <mark> из поиска, текст экранирован на сервере */}
                  <span dangerouslySetInnerHTML={{ __html: hit.snippet }} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {pinsOpen ? (
        <div className="shrink-0 border-b border-line bg-surface-2 p-2">
          {(pins?.items ?? []).length === 0 ? (
            <p className="text-2xs text-fg-muted">{t('chats.pinnedEmpty')}</p>
          ) : (
            <ul aria-label={t('chats.pinnedTitle')} className="flex flex-col gap-1">
              {(pins?.items ?? []).map((item) => (
                <li
                  key={item.messageId}
                  className="flex items-center gap-2 rounded-sm border border-line bg-surface px-2 py-1 text-xs"
                >
                  <Pin className="size-3 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-fg-secondary">{item.text}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => pin.mutate({ messageId: item.messageId, on: false })}
                  >
                    {t('chats.unpinMessage')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="size-6" />}
            title={t('chats.emptyFeed')}
            description={t('chats.emptyFeedHint')}
          />
        ) : (
          <>
            {data?.nextCursor ? (
              <div className="mb-2 flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 50)}>
                  {t('chats.loadMore')}
                </Button>
              </div>
            ) : null}
            {groups.map((group) => (
              <section key={group.day} aria-label={group.day}>
                <div className="my-2 flex items-center gap-2">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-2xs text-fg-muted">{group.day}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
                <ul className="flex flex-col gap-3">
                  {group.items.map((message) => (
                    <li key={message.id} className="group/message">
                      {unreadFrom === message.id ? (
                        <div className="mb-2 flex items-center gap-2">
                          <span className="h-px flex-1 bg-danger" />
                          <span className="text-2xs text-danger">{t('chats.unreadFrom')}</span>
                          <span className="h-px flex-1 bg-danger" />
                        </div>
                      ) : null}
                      <div className="flex items-start gap-1">
                        {selected && !message.deletedAt && message.kind !== 'system' ? (
                          <Checkbox
                            className="mt-1.5"
                            checked={selected.includes(message.id)}
                            onCheckedChange={() => toggleSelected(message.id)}
                            aria-label={t('chats.selectMessage', {
                              author: message.author?.displayName ?? '',
                            })}
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <MessageItem
                            message={message}
                            objectId={conversation.id}
                            canReact={conversation.can.post}
                            editing={editingId === message.id}
                            onEditEnd={() => setEditingId(null)}
                            receipt={receiptOf(message)}
                          />
                          {translations[message.id] ? (
                            <p className="ml-9 mt-1 whitespace-pre-wrap border-l-2 border-accent pl-2 text-xs text-fg-secondary">
                              {translations[message.id]}
                            </p>
                          ) : null}
                          {message.threadReplyCount > 0 ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-9 mt-1"
                              onClick={() => onThread(message.id)}
                            >
                              {t('chats.threadReplies', { count: message.threadReplyCount })}
                            </Button>
                          ) : null}
                        </div>
                        {message.deletedAt || selected ? null : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                size="sm"
                                label={t('chats.actions')}
                                className={cn(
                                  'opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100',
                                  '[@media(hover:none)]:opacity-100',
                                )}
                              >
                                <MoreHorizontal className="size-3.5" />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => onThread(message.id)}>
                                {t('chats.reply')}
                              </DropdownMenuItem>
                              {ai?.enabled ? (
                                <DropdownMenuItem
                                  onSelect={() =>
                                    translate.mutate({
                                      messageId: message.id,
                                      text: message.text,
                                    })
                                  }
                                >
                                  <Languages className="mr-2 size-3.5" aria-hidden />
                                  {t('chats.translate')}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                onSelect={() => pin.mutate({ messageId: message.id, on: true })}
                              >
                                {t('chats.pinMessage')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setDialog({ kind: 'forward', messageIds: [message.id] })
                                }
                              >
                                <Share2 className="mr-2 size-3.5" aria-hidden />
                                {t('chats.forward')}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setSelected([message.id])}>
                                <ListChecks className="mr-2 size-3.5" aria-hidden />
                                {t('chats.select')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() =>
                                  setDialog({
                                    kind: 'task',
                                    messageId: message.id,
                                    text: message.text,
                                  })
                                }
                              >
                                <CheckSquare className="mr-2 size-3.5" aria-hidden />
                                {t('chats.createTask')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  setDialog({ kind: 'attach', messageId: message.id })
                                }
                              >
                                <Link2 className="mr-2 size-3.5" aria-hidden />
                                {t('chats.attachTo')}
                              </DropdownMenuItem>
                              {message.can.edit || message.can.delete ? (
                                <DropdownMenuSeparator />
                              ) : null}
                              {message.can.edit ? (
                                <DropdownMenuItem onSelect={() => setEditingId(message.id)}>
                                  <Pencil className="mr-2 size-3.5" aria-hidden />
                                  {t('discussion.editMessage')}
                                </DropdownMenuItem>
                              ) : null}
                              {message.can.delete ? (
                                <DropdownMenuItem
                                  danger
                                  onSelect={() =>
                                    setDialog({ kind: 'delete', messageId: message.id })
                                  }
                                >
                                  <Trash2 className="mr-2 size-3.5" aria-hidden />
                                  {t('discussion.deleteMessage')}
                                </DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <p aria-live="polite" className="h-4 shrink-0 truncate px-3 text-2xs text-fg-muted">
        {typing ?? ''}
      </p>

      {selected ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2">
          <span className="text-sm text-fg">{t('chats.selected', { count: selected.length })}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={selected.length === 0}
              onClick={() => setDialog({ kind: 'forward', messageIds: selected })}
            >
              <Share2 className="mr-1.5 size-3.5" aria-hidden />
              {t('chats.forward')}
            </Button>
          </div>
        </div>
      ) : conversation.can.post ? (
        <>
          <p className="shrink-0 px-3 text-2xs text-fg-muted">{t('chats.commandHint')}</p>
          <MessageComposer
            key={conversation.id}
            placeholder={t('chats.placeholder')}
            pending={post.isPending}
            onValueChange={(text) => {
              // «Печатает» — соседям по беседе, не чаще раза в несколько секунд
              if (text && Date.now() - typingSentRef.current > TYPING_EVERY_MS) {
                typingSentRef.current = Date.now()
                emitTyping(conversation.id)
              }
              // Черновик сохраняется не на каждый символ: раз в дюжину и при очистке
              if (text.length === 0 || text.length % 12 === 0) saveDraft.mutate(text)
            }}
            onSend={async (message) => {
              if (command(message.text)) return
              await post.mutateAsync(message)
              saveDraft.mutate('')
            }}
            onAttach={async (file) => {
              const created = await uploadFile({
                file,
                spaceId: conversation.spaceId ?? '',
                attachToObjectId: conversation.objectId ?? conversation.id,
              })
              return { id: created.id, name: file.name, size: file.size }
            }}
          />
        </>
      ) : null}

      {dialog?.kind === 'task' ? (
        <MessageTaskDialog
          messageId={dialog.messageId}
          initialTitle={dialog.text}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'attach' ? (
        <AttachDialog messageId={dialog.messageId} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'forward' ? (
        <ForwardDialog
          messageIds={dialog.messageIds}
          onClose={() => setDialog(null)}
          onDone={() => setSelected(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteMessageDialog
          messageId={dialog.messageId}
          objectId={conversation.id}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'invite' ? (
        <InviteDialog conversationId={conversation.id} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <RenameDialog conversation={conversation} onClose={() => setDialog(null)} />
      ) : null}
      {threadRootId ? (
        <ThreadPanel
          conversation={conversation}
          rootId={threadRootId}
          onClose={() => onThread(null)}
        />
      ) : null}
    </div>
  )
}

/** Тред — панель рядом с лентой: корень и ответы (P4-E01 S02). */
function ThreadPanel({
  conversation,
  rootId,
  onClose,
}: {
  conversation: ChatListItem
  rootId: string
  onClose: () => void
}) {
  const t = useT()
  const client = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { data } = useQuery(chatMessagesQuery(conversation.id, rootId))
  const post = useMutation({
    mutationFn: (message: { body: unknown; text: string; mentions: string[] }) =>
      http.post(`/conversations/${conversation.id}/messages`, {
        body: message.body,
        text: message.text,
        attachments: [],
        mentions: message.mentions,
        mentionedObjectIds: [],
        threadRootId: rootId,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.discussion(conversation.id) }),
  })
  return (
    <aside
      aria-label={t('chats.thread')}
      className="absolute inset-y-0 right-0 flex w-80 flex-col border-l border-line bg-surface shadow-lg"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <h3 className="text-sm font-medium text-fg">{t('chats.thread')}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <ul className="flex flex-col gap-3">
          {(data?.items ?? []).map((message) => (
            <li key={message.id} className="group/message flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <MessageItem
                  message={message}
                  objectId={conversation.id}
                  canReact={conversation.can.post}
                  editing={editingId === message.id}
                  onEditEnd={() => setEditingId(null)}
                />
              </div>
              <MessageMenu
                message={message}
                onEdit={() => setEditingId(message.id)}
                onDelete={() => setDeletingId(message.id)}
              />
            </li>
          ))}
        </ul>
      </div>
      {conversation.can.post ? (
        <MessageComposer
          placeholder={t('chats.threadPlaceholder')}
          pending={post.isPending}
          onSend={(message) => post.mutateAsync(message)}
        />
      ) : null}
      {deletingId ? (
        <DeleteMessageDialog
          messageId={deletingId}
          objectId={conversation.id}
          onClose={() => setDeletingId(null)}
        />
      ) : null}
    </aside>
  )
}
