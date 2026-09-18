import type { Message } from '@kchs/contracts'
import { formatFileSize, formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  cn,
  IconButton,
  ObjectIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { SmilePlus } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'

/** Быстрые реакции: согласие, «сделано», «смотрю», поздравление, поддержка, благодарность. */
const QUICK_REACTIONS = ['👍', '✅', '👀', '🎉', '❤️', '🙏'] as const

/**
 * Сообщение обсуждения (P0-E08): текст, вложения — открываются во вкладке,
 * реакции — поставить или снять одним нажатием, если можно писать.
 */
export function MessageItem({
  message,
  objectId,
  canReact,
}: {
  message: Message
  objectId: string
  canReact: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const toast = useToast()
  const client = useQueryClient()
  const [picking, setPicking] = useState(false)
  const author = message.author?.displayName ?? t('discussion.systemAuthor')

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
          {message.editedAt ? (
            <span className="text-2xs text-fg-muted">{t('discussion.edited')}</span>
          ) : null}
          {canReact ? (
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
        {message.text || message.kind === 'system' ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg-secondary">
            {message.kind === 'system' && message.systemKey
              ? t(message.systemKey, message.systemParams as Record<string, string>)
              : message.text}
          </p>
        ) : null}

        {message.attachments.length > 0 ? (
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

        {message.reactions.length > 0 ? (
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
                disabled={!canReact || react.isPending}
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
