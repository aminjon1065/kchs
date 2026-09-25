import type { Message } from '@kchs/contracts'
import { formatFileSize, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  ObjectIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageSquareReply, MoreHorizontal, Pencil, SmilePlus, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { composeMessage, mentionsOf } from './mention-doc.js'

/** Быстрые реакции: согласие, «сделано», «смотрю», поздравление, поддержка, благодарность. */
const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '🙏'] as const

/**
 * Сообщение обсуждения (P0-E08): текст, вложения — открываются во вкладке,
 * реакции — поставить или снять одним нажатием, если можно писать. Удалённое
 * остаётся строкой «Сообщение удалено»; в режиме правки текст меняется на месте
 * (ADR-0161). `receipt` — отметка прочтения своего сообщения в беседе.
 */
export function MessageItem({
  message,
  objectId,
  canReact,
  editing = false,
  onEditEnd,
  receipt,
}: {
  message: Message
  objectId: string
  canReact: boolean
  editing?: boolean
  onEditEnd?: () => void
  receipt?: ReactNode
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const toast = useToast()
  const client = useQueryClient()
  const [picking, setPicking] = useState(false)
  const author = message.author?.displayName ?? t('discussion.systemAuthor')
  const deleted = Boolean(message.deletedAt)
  const reactable = canReact && !deleted

  const react = useMutation({
    mutationFn: ({ emoji, on }: { emoji: string; on: boolean }) =>
      http.put(`/messages/${message.id}/reactions`, { emoji, on }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.discussion(objectId) }),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <article className="group flex gap-2">
      <Avatar name={author} src={message.author?.avatarUrl} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-fg">{author}</span>
          <time className="shrink-0 text-2xs text-fg-muted" dateTime={message.createdAt}>
            {formatRelativeTime(message.createdAt, { locale })}
          </time>
          {message.editedAt && !deleted ? (
            <span className="text-2xs text-fg-muted">{t('discussion.edited')}</span>
          ) : null}
          {receipt && !deleted ? receipt : null}
          {reactable && !editing ? (
            <Popover open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <IconButton
                  size="sm"
                  label={t('discussion.addReaction')}
                  className={cn(
                    // На сенсорных экранах наведения нет — кнопка видна всегда
                    'ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
                    picking && 'opacity-100',
                  )}
                >
                  <SmilePlus className="size-3.5" />
                </IconButton>
              </PopoverTrigger>
              <PopoverContent className="flex gap-0.5 p-1">
                {QUICK_REACTIONS.map((emoji) => {
                  const mine = message.reactions.some(
                    (reaction) => reaction.emoji === emoji && reaction.mine,
                  )
                  return (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={t('discussion.react', { emoji })}
                      aria-pressed={mine}
                      onClick={() => {
                        react.mutate({ emoji, on: !mine })
                        setPicking(false)
                      }}
                      className={cn(
                        'flex size-8 items-center justify-center rounded-sm text-base hover:bg-surface-3',
                        mine && 'bg-accent-subtle',
                      )}
                    >
                      {emoji}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
        {deleted ? (
          <p className="mt-0.5 text-sm italic text-fg-muted">{t('discussion.deleted')}</p>
        ) : editing ? (
          <MessageEditor message={message} objectId={objectId} onDone={() => onEditEnd?.()} />
        ) : message.text || message.kind === 'system' ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-secondary">
            {message.kind === 'system' && message.systemKey
              ? t(message.systemKey, message.systemParams as Record<string, string>)
              : message.text}
          </p>
        ) : null}

        {message.attachments.length > 0 && !deleted ? (
          <ul className="mt-1.5 flex flex-col gap-1">
            {message.attachments.map((attachment) => (
              <li key={attachment.fileId}>
                <button
                  type="button"
                  onClick={() =>
                    openTab({
                      kind: 'object',
                      objectId: attachment.fileId,
                      objectType: 'file',
                      title: attachment.name,
                      mode: 'permanent',
                    })
                  }
                  className="flex max-w-full items-center gap-2 rounded-sm border border-line bg-surface-2 px-2 py-1 text-left text-xs hover:bg-surface-3"
                >
                  <ObjectIcon type="file" className="size-3.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 truncate text-fg">{attachment.name}</span>
                  <span className="shrink-0 text-fg-muted">
                    {formatFileSize(attachment.size, { locale })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {message.reactions.length > 0 && !deleted ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                aria-pressed={reaction.mine}
                aria-label={t('discussion.reactionOf', {
                  emoji: reaction.emoji,
                  count: reaction.count,
                })}
                disabled={!reactable || react.isPending}
                onClick={() => react.mutate({ emoji: reaction.emoji, on: !reaction.mine })}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs',
                  reaction.mine
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line bg-surface text-fg-secondary hover:bg-surface-2',
                  'disabled:cursor-default',
                )}
              >
                <span aria-hidden>{reaction.emoji}</span>
                <span className="tabular">{reaction.count}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}

/**
 * Правка на месте: упоминания из прежнего тела сохраняются, стёртое из текста
 * упоминание уходит. Esc — отмена, ⌘/Ctrl+Enter — сохранить.
 */
function MessageEditor({
  message,
  objectId,
  onDone,
}: {
  message: Message
  objectId: string
  onDone: () => void
}) {
  const t = useT()
  const client = useQueryClient()
  const [draft, setDraft] = useState(message.text)
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () => {
      const composed = composeMessage(draft, mentionsOf(message.body))
      if (!composed) throw new Error(t('discussion.editEmpty'))
      return http.patch(`/messages/${message.id}`, {
        body: composed.body,
        text: composed.text,
        mentions: composed.mentions,
        mentionedObjectIds: message.mentionedObjectIds,
      })
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.discussion(objectId) })
      onDone()
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('errors.unknown')),
  })
  return (
    <form
      className="mt-1 flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <Textarea
        value={draft}
        autoFocus
        autoGrow
        aria-label={t('discussion.editLabel')}
        invalid={Boolean(error)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onDone()
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save.mutate()
          }
        }}
      />
      {error ? <p className="text-2xs text-danger">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={draft.trim() === message.text.trim()}
        >
          {t('common.actions.save')}
        </Button>
      </div>
    </form>
  )
}

/**
 * Меню сообщения обсуждения: ответ в треде, правка и удаление своего (ADR-0161).
 * Пунктов нет — меню не показывается.
 */
export function MessageMenu({
  message,
  onThread,
  onEdit,
  onDelete,
}: {
  message: Message
  onThread?: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const t = useT()
  if (message.deletedAt && !onThread) return null
  if (!onThread && !message.can.edit && !message.can.delete) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          label={t('discussion.actions')}
          className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <MoreHorizontal className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onThread ? (
          <DropdownMenuItem onSelect={onThread}>
            <MessageSquareReply className="mr-2 size-3.5" aria-hidden />
            {t('discussion.replyInThread')}
          </DropdownMenuItem>
        ) : null}
        {message.can.edit ? (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="mr-2 size-3.5" aria-hidden />
            {t('discussion.editMessage')}
          </DropdownMenuItem>
        ) : null}
        {message.can.delete ? (
          <DropdownMenuItem danger onSelect={onDelete}>
            <Trash2 className="mr-2 size-3.5" aria-hidden />
            {t('discussion.deleteMessage')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Подтверждение удаления: в ленте остаётся строка «Сообщение удалено», текст,
 * вложения и реакции стираются (ADR-0161).
 */
export function DeleteMessageDialog({
  messageId,
  objectId,
  onClose,
}: {
  messageId: string
  objectId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: () => http.delete(`/messages/${messageId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.discussion(objectId) })
      void client.invalidateQueries({ queryKey: ['chats'] })
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })
  return (
    <AlertDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('discussion.deleteTitle')}
      description={t('discussion.deleteHint')}
      confirmLabel={t('discussion.deleteMessage')}
      loading={remove.isPending}
      onConfirm={() => remove.mutate()}
    />
  )
}
