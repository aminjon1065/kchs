import * as AvatarPrimitive from '@radix-ui/react-avatar'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronRight, TrendingDown, TrendingUp } from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { cspNonce } from '../lib/csp-nonce.js'

// ─── Badge, Tag, Chip ────────────────────────────────────────────────────────

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-xs px-1.5 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-3 text-fg-secondary',
        accent: 'bg-accent-subtle text-accent',
        success: 'bg-success-subtle text-success',
        warning: 'bg-warning-subtle text-warning',
        danger: 'bg-danger-subtle text-danger',
        purple: 'bg-purple-subtle text-purple',
        outline: 'border border-line bg-transparent text-fg-secondary',
      },
      size: { sm: 'h-4 text-2xs', md: 'h-5 text-xs' },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean
}

export function Badge({ className, tone, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  )
}

/** Статус задачи/документа — цвет закреплён за значением (02-design-system.md §2). */
export const STATUS_TONES: Record<string, BadgeProps['tone']> = {
  draft: 'neutral',
  todo: 'neutral',
  in_progress: 'accent',
  on_approval: 'purple',
  on_signing: 'purple',
  review: 'purple',
  done: 'success',
  executed: 'success',
  accepted: 'success',
  registered: 'success',
  overdue: 'danger',
  rejected: 'danger',
  returned: 'warning',
  cancelled: 'neutral',
}

export function StatusBadge({ status, label }: { status: string; label?: ReactNode }) {
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} dot>
      {label ?? status}
    </Badge>
  )
}

/**
 * Цвет тега — ключ категориальной палитры (`chart-1`…`chart-10`), чтобы тег
 * одинаково читался в обеих темах. Прочие значения показываются без цвета.
 */
const TAG_DOT: Record<string, string> = {
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5',
  'chart-6': 'bg-chart-6',
  'chart-7': 'bg-chart-7',
  'chart-8': 'bg-chart-8',
  'chart-9': 'bg-chart-9',
  'chart-10': 'bg-chart-10',
}

export function Tag({
  children,
  color,
  onRemove,
  className,
}: {
  children: ReactNode
  color?: string | null
  onRemove?: () => void
  className?: string
}) {
  const t = useUiT()
  const dot = color ? TAG_DOT[color] : undefined
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-xs border border-line bg-surface-2 px-1.5 text-xs text-fg-secondary',
        className,
      )}
    >
      {dot ? <span className={cn('size-1.5 rounded-full', dot)} aria-hidden /> : null}
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 rounded-xs text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-label={
            typeof children === 'string'
              ? t('ui.tag.removeNamed', { name: children })
              : t('ui.tag.remove')
          }
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

// ─── Avatar ──────────────────────────────────────────────────────────────────

/** Цвет человека даёт подложка; инициалы — основным цветом текста (контраст AA). */
const AVATAR_TONES = [
  'bg-chart-1/20 text-fg',
  'bg-chart-2/20 text-fg',
  'bg-chart-3/20 text-fg',
  'bg-chart-5/20 text-fg',
  'bg-chart-6/20 text-fg',
  'bg-chart-8/20 text-fg',
]

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

function toneFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length]!
}

const avatarSizes = {
  xs: 'size-5 text-2xs',
  sm: 'size-6 text-2xs',
  md: 'size-7 text-xs',
  lg: 'size-9 text-sm',
  xl: 'size-12 text-md',
}

export interface AvatarProps {
  name: string
  src?: string | null
  size?: keyof typeof avatarSizes
  className?: string
  /** Точка присутствия. */
  status?: 'online' | 'away' | 'dnd' | null
}

export function Avatar({ name, src, size = 'md', className, status }: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <AvatarPrimitive.Root
        className={cn(
          'inline-flex items-center justify-center overflow-hidden rounded-full font-medium select-none',
          avatarSizes[size],
          toneFor(name),
        )}
      >
        {src ? <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" /> : null}
        <AvatarPrimitive.Fallback delayMs={src ? 300 : 0}>
          {initialsOf(name)}
        </AvatarPrimitive.Fallback>
      </AvatarPrimitive.Root>
      {status ? (
        <span
          aria-hidden
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-surface',
            status === 'online' && 'bg-success',
            status === 'away' && 'bg-warning',
            status === 'dnd' && 'bg-danger',
          )}
        />
      ) : null}
    </span>
  )
}

export function AvatarGroup({
  people,
  max = 4,
  size = 'sm',
}: {
  people: Array<{ name: string; src?: string | null }>
  max?: number
  size?: AvatarProps['size']
}) {
  const visible = people.slice(0, max)
  const rest = people.length - visible.length
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((person, index) => (
        <Avatar
          key={`${person.name}-${index}`}
          name={person.name}
          src={person.src}
          size={size}
          className="ring-2 ring-surface"
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-surface-3 font-medium text-fg-secondary ring-2 ring-surface',
            avatarSizes[size ?? 'sm'],
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  )
}

// ─── Card, StatTile, KeyValueList ───────────────────────────────────────────

export function Card({
  className,
  children,
  title,
  action,
  padded = true,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode
  action?: ReactNode
  padded?: boolean
}) {
  return (
    <div
      className={cn('flex flex-col rounded-lg border border-line bg-surface shadow-sm', className)}
      {...props}
    >
      {title || action ? (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="truncate text-sm font-semibold text-fg">{title}</div>
          {action}
        </div>
      ) : null}
      <div className={cn('min-h-0 flex-1', padded && 'p-[var(--card-pad)]')}>{children}</div>
    </div>
  )
}

export interface StatTileProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  delta?: { value: number; label?: ReactNode; direction?: 'higher_better' | 'lower_better' }
  spark?: number[]
  className?: string
  onClick?: () => void
}

export function StatTile({ label, value, unit, delta, spark, className, onClick }: StatTileProps) {
  const positive = delta ? delta.value >= 0 : false
  const good = delta ? (delta.direction === 'lower_better' ? !positive : positive) : true

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-[var(--card-pad)]',
        onClick && 'cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2',
        className,
      )}
      {...(onClick
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            },
          }
        : {})}
    >
      <div className="truncate text-xs text-fg-secondary">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-2xl font-semibold leading-none text-fg">{value}</span>
        {unit ? <span className="text-xs text-fg-muted">{unit}</span> : null}
      </div>
      {delta ? (
        <div
          className={cn('flex items-center gap-1 text-xs', good ? 'text-success' : 'text-danger')}
        >
          {positive ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
          <span className="tabular">
            {positive ? '+' : ''}
            {delta.value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%
          </span>
          {delta.label ? <span className="text-fg-muted">{delta.label}</span> : null}
        </div>
      ) : null}
      {spark && spark.length > 1 ? <Sparkline values={spark} /> : null}
    </div>
  )
}

export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / range) * 26}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className={cn('h-7 w-full text-accent', className)}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export interface KeyValueItem {
  key: string
  label: ReactNode
  value: ReactNode
}

export function KeyValueList({
  items,
  className,
  columns = 1,
}: {
  items: KeyValueItem[]
  className?: string
  columns?: 1 | 2
}) {
  return (
    <dl
      className={cn(
        'grid gap-x-4 gap-y-2.5 text-sm',
        columns === 2
          ? 'grid-cols-[max-content_1fr_max-content_1fr]'
          : 'grid-cols-[minmax(96px,max-content)_1fr]',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className="truncate text-xs text-fg-muted">{item.label}</dt>
          <dd className="min-w-0 text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ─── Tabs, Separator, ScrollArea, Breadcrumbs ───────────────────────────────

export const Tabs = TabsPrimitive.Root

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'flex items-center gap-0.5 border-b border-line',
        // Вертикальные вкладки — навигация по разделам экрана (консоль администрирования)
        'data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:border-b-0',
        className,
      )}
      {...props}
    />
  )
})

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { count?: number }
>(function TabsTrigger({ className, children, count, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'relative inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-t-sm px-2.5 text-sm font-medium',
        'text-fg-secondary transition-colors duration-[var(--duration-fast)]',
        'hover:text-fg',
        'data-[state=active]:text-fg',
        'after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full',
        'data-[state=active]:after:bg-accent',
        // Вертикально: строка во всю ширину, подложка у выбранной, метка слева
        'data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-[orientation=vertical]:rounded-sm',
        'data-[orientation=vertical]:hover:bg-surface-2 data-[orientation=vertical]:data-[state=active]:bg-surface-2',
        'data-[orientation=vertical]:after:inset-x-auto data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:inset-y-1.5 data-[orientation=vertical]:after:h-auto data-[orientation=vertical]:after:w-0.5',
        className,
      )}
      {...props}
    >
      {children}
      {typeof count === 'number' ? (
        <span className="tabular rounded-xs bg-surface-3 px-1 text-2xs text-fg-muted">{count}</span>
      ) : null}
    </TabsPrimitive.Trigger>
  )
})

export const TabsContent = TabsPrimitive.Content

export const Separator = forwardRef<
  ElementRef<typeof SeparatorPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(function Separator({ className, orientation = 'horizontal', ...props }, ref) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
})

export const ScrollArea = forwardRef<
  ElementRef<typeof ScrollAreaPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(function ScrollArea({ className, children, ...props }, ref) {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={cn('relative overflow-hidden', className)}
      scrollHideDelay={600}
      {...props}
    >
      {/* Viewport рисует свой <style> — ему нужен nonce CSP страницы (ADR-0043) */}
      <ScrollAreaPrimitive.Viewport
        className="size-full rounded-[inherit]"
        tabIndex={0}
        nonce={cspNonce()}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5 transition-opacity"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-border-strong" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
})

export interface BreadcrumbItem {
  id: string
  label: ReactNode
  onClick?: () => void
  icon?: ReactNode
}

export function Breadcrumbs({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  const t = useUiT()
  return (
    <nav
      aria-label={t('ui.breadcrumbs.label')}
      className={cn('flex min-w-0 items-center gap-1', className)}
    >
      {items.map((item, index) => (
        <span key={item.id} className="flex min-w-0 items-center gap-1">
          {index > 0 ? (
            <ChevronRight className="size-3 shrink-0 text-fg-muted" aria-hidden />
          ) : null}
          <button
            type="button"
            onClick={item.onClick}
            disabled={!item.onClick}
            className={cn(
              'flex min-w-0 items-center gap-1 truncate rounded-xs px-1 text-xs',
              index === items.length - 1 ? 'text-fg-secondary' : 'text-fg-muted',
              item.onClick && 'hover:bg-surface-3 hover:text-fg',
            )}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        </span>
      ))}
    </nav>
  )
}
