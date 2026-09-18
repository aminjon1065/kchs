import type { ReactNode } from 'react'
import { Avatar } from '../components/data-display.js'
import { ObjectIcon } from '../icons/object-icon.js'
import { cn } from '../lib/cn.js'
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card.js'

export interface ObjectChipData {
  id: string
  type: string
  title: string
  subtitle?: string | null
  icon?: string | null
  spaceName?: string | null
  ownerName?: string | null
  status?: string | null
  accessible?: boolean
  url?: string
}

export interface ObjectChipProps {
  object: ObjectChipData
  onOpen?: (object: ObjectChipData) => void
  onOpenInSplit?: (object: ObjectChipData) => void
  size?: 'sm' | 'md'
  className?: string
  /** Дополнительные поля в карточке при наведении. */
  details?: Array<{ label: string; value: ReactNode }>
}

/**
 * Чип объекта: иконка типа + название; при наведении — карточка
 * (03-ui/04-interaction-patterns.md §12).
 */
export function ObjectChip({
  object,
  onOpen,
  onOpenInSplit,
  size = 'md',
  className,
  details,
}: ObjectChipProps) {
  if (object.accessible === false) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-xs border border-dashed border-line px-1.5 text-fg-muted',
          size === 'sm' ? 'h-5 text-2xs' : 'h-6 text-xs',
          className,
        )}
        title="У вас нет доступа к этому объекту"
      >
        <ObjectIcon type="lock" className="size-3.5" />
        Нет доступа
      </span>
    )
  }

  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen?.(object)}
          className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-xs border border-line bg-surface-2 px-1.5',
            'text-fg transition-colors hover:border-line-strong hover:bg-surface-3',
            size === 'sm' ? 'h-5 text-2xs' : 'h-6 text-xs',
            className,
          )}
        >
          <ObjectIcon type={object.icon ?? object.type} className="size-3.5 shrink-0" />
          <span className="truncate">{object.title}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <div className="flex items-start gap-2.5">
          <ObjectIcon
            type={object.icon ?? object.type}
            className="mt-0.5 size-5 shrink-0 text-fg-muted"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-fg">{object.title}</div>
            {object.subtitle ? (
              <div className="mt-0.5 truncate text-xs text-fg-secondary">{object.subtitle}</div>
            ) : null}
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              {object.spaceName ? (
                <>
                  <dt className="text-fg-muted">Пространство</dt>
                  <dd className="truncate text-fg-secondary">{object.spaceName}</dd>
                </>
              ) : null}
              {object.ownerName ? (
                <>
                  <dt className="text-fg-muted">Владелец</dt>
                  <dd className="truncate text-fg-secondary">{object.ownerName}</dd>
                </>
              ) : null}
              {details?.map((detail) => (
                <span key={detail.label} className="contents">
                  <dt className="text-fg-muted">{detail.label}</dt>
                  <dd className="truncate text-fg-secondary">{detail.value}</dd>
                </span>
              ))}
            </dl>
            <div className="mt-2.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => onOpen?.(object)}
                className="h-6 rounded-sm border border-line-strong px-2 text-xs font-medium hover:bg-surface-3"
              >
                Открыть
              </button>
              {onOpenInSplit ? (
                <button
                  type="button"
                  onClick={() => onOpenInSplit(object)}
                  className="h-6 rounded-sm border border-line-strong px-2 text-xs font-medium hover:bg-surface-3"
                >
                  В разделении
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export interface UserChipData {
  id: string
  displayName: string
  avatarUrl?: string | null
  position?: string | null
  unitName?: string | null
}

export function UserChip({
  user,
  size = 'sm',
  showName = true,
  className,
}: {
  user: UserChipData
  size?: 'xs' | 'sm' | 'md'
  showName?: boolean
  className?: string
}) {
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
          <Avatar name={user.displayName} src={user.avatarUrl} size={size} />
          {showName ? (
            <span className="truncate text-xs text-fg-secondary">{user.displayName}</span>
          ) : null}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-64">
        <div className="flex items-start gap-2.5">
          <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-fg">{user.displayName}</div>
            {user.position ? (
              <div className="truncate text-xs text-fg-secondary">{user.position}</div>
            ) : null}
            {user.unitName ? (
              <div className="truncate text-xs text-fg-muted">{user.unitName}</div>
            ) : null}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
