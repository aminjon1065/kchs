import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Command as CommandPrimitive } from 'cmdk'
import { ChevronRight, Search } from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  type ElementRef,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Kbd } from '../primitives/overlays.js'

// ─── Collapsible ─────────────────────────────────────────────────────────────

export const Collapsible = CollapsiblePrimitive.Root
export const CollapsibleContent = CollapsiblePrimitive.Content

export const CollapsibleTrigger = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(function CollapsibleTrigger({ className, children, ...props }, ref) {
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      className={cn(
        'group flex w-full items-center gap-1 rounded-sm px-1.5 py-1 text-2xs font-medium uppercase',
        'tracking-wide text-fg-muted hover:text-fg-secondary',
        className,
      )}
      {...props}
    >
      <ChevronRight
        className="size-3 transition-transform group-data-[state=open]:rotate-90"
        aria-hidden
      />
      {children}
    </CollapsiblePrimitive.Trigger>
  )
})

// ─── Tree ────────────────────────────────────────────────────────────────────

export interface TreeNode {
  id: string
  label: ReactNode
  icon?: ReactNode
  children?: TreeNode[]
  /** Есть дети, но они ещё не загружены. */
  hasChildren?: boolean
  badge?: ReactNode
  meta?: unknown
}

export interface TreeProps {
  nodes: TreeNode[]
  selectedId?: string | null
  expandedIds: Set<string>
  onToggle: (id: string) => void
  onSelect: (node: TreeNode) => void
  onActivate?: (node: TreeNode) => void
  className?: string
  emptyState?: ReactNode
  level?: number
}

export function Tree({
  nodes,
  selectedId,
  expandedIds,
  onToggle,
  onSelect,
  onActivate,
  className,
  emptyState,
  level = 0,
}: TreeProps) {
  const t = useUiT()
  if (nodes.length === 0 && level === 0) {
    return <div className="px-2 py-3 text-xs text-fg-muted">{emptyState ?? t('ui.empty')}</div>
  }

  return (
    <ul role={level === 0 ? 'tree' : 'group'} className={cn('flex flex-col', className)}>
      {nodes.map((node) => {
        const expandable = Boolean(node.children?.length || node.hasChildren)
        const expanded = expandedIds.has(node.id)
        const selected = selectedId === node.id
        return (
          <li key={node.id} role="none">
            <div
              role="treeitem"
              aria-selected={selected}
              aria-expanded={expandable ? expanded : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(node)}
              onDoubleClick={() => onActivate?.(node)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onActivate?.(node)
                if (event.key === 'ArrowRight' && expandable && !expanded) onToggle(node.id)
                if (event.key === 'ArrowLeft' && expandable && expanded) onToggle(node.id)
              }}
              style={{ paddingLeft: `${6 + level * 14}px` }}
              className={cn(
                'group flex h-7 cursor-pointer items-center gap-1.5 rounded-sm pr-1.5 text-sm',
                'transition-colors duration-[var(--duration-fast)]',
                selected
                  ? 'bg-accent-subtle text-accent'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
              )}
            >
              {expandable ? (
                <button
                  type="button"
                  aria-label={expanded ? t('ui.tree.collapse') : t('ui.tree.expand')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggle(node.id)
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded-xs text-fg-muted hover:bg-surface-3"
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform', expanded && 'rotate-90')}
                    aria-hidden
                  />
                </button>
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              {node.icon ? <span className="shrink-0 [&_svg]:size-4">{node.icon}</span> : null}
              <span className="min-w-0 flex-1 truncate">{node.label}</span>
              {node.badge}
            </div>
            {expanded && node.children?.length ? (
              <Tree
                nodes={node.children}
                selectedId={selectedId}
                expandedIds={expandedIds}
                onToggle={onToggle}
                onSelect={onSelect}
                onActivate={onActivate}
                level={level + 1}
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

// ─── VirtualList ─────────────────────────────────────────────────────────────

export interface VirtualListProps<T> {
  items: T[]
  rowHeight: number
  renderRow: (item: T, index: number) => ReactNode
  className?: string
  overscan?: number
  onEndReached?: () => void
  getKey?: (item: T, index: number) => string
}

export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  className,
  overscan = 10,
  onEndReached,
  getKey,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  })

  const handleScroll = useCallback(() => {
    const el = parentRef.current
    if (!el || !onEndReached) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 4) onEndReached()
  }, [onEndReached, rowHeight])

  return (
    <div
      ref={parentRef}
      onScroll={handleScroll}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: прокручиваемая область должна получать фокус, иначе список не прокрутить с клавиатуры (WCAG 2.1.1, axe scrollable-region-focusable)
      tabIndex={0}
      className={cn('h-full overflow-auto', className)}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]!
          return (
            <div
              key={getKey?.(item, virtualRow.index) ?? virtualRow.key}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {renderRow(item, virtualRow.index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Command (палитра) ───────────────────────────────────────────────────────

export interface CommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  placeholder?: string
  value: string
  onValueChange: (value: string) => void
  /**
   * Значение первого элемента списка. Фильтрация выполняется на сервере
   * (`shouldFilter={false}`), поэтому выделение задаётся явно — иначе
   * Enter не на чем сработать.
   */
  firstValue?: string
  children: ReactNode
  footer?: ReactNode
  loading?: boolean
}

export function CommandDialog({
  open,
  onOpenChange,
  placeholder,
  value,
  onValueChange,
  firstValue = '',
  children,
  footer,
  loading,
}: CommandDialogProps) {
  const t = useUiT()
  const [selected, setSelected] = useState('')

  useEffect(() => {
    setSelected('')
  }, [])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-(--z-modal) flex items-start justify-center pt-[12vh]">
      {/* Подложка — кнопка: закрытие доступно и с клавиатуры */}
      <button
        type="button"
        aria-label={t('ui.command.close')}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-black/30 animate-fade"
      />
      <div
        className="relative w-[min(680px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-overlay shadow-lg animate-enter"
        role="dialog"
        aria-modal="true"
        aria-label={t('ui.command.label')}
      >
        <CommandPrimitive
          shouldFilter={false}
          loop
          value={selected || firstValue}
          onValueChange={setSelected}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onOpenChange(false)
          }}
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 shrink-0 text-fg-muted" aria-hidden />
            <CommandPrimitive.Input
              autoFocus
              value={value}
              onValueChange={onValueChange}
              placeholder={placeholder ?? t('ui.command.placeholder')}
              className="h-11 flex-1 bg-transparent text-base outline-none placeholder:text-fg-muted"
            />
            {loading ? (
              <span className="text-2xs text-fg-muted">{t('ui.command.searching')}</span>
            ) : null}
            <Kbd>Esc</Kbd>
          </div>
          <CommandPrimitive.List className="max-h-[52vh] overflow-auto p-1.5">
            {children}
          </CommandPrimitive.List>
        </CommandPrimitive>
        {footer ? (
          <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1.5 text-2xs text-fg-muted">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const CommandGroup = CommandPrimitive.Group
export const CommandEmpty = CommandPrimitive.Empty
export const CommandSeparator = CommandPrimitive.Separator

export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item> & {
    icon?: ReactNode
    hint?: ReactNode
    shortcut?: string
  }
>(function CommandItem({ className, icon, hint, shortcut, children, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm',
        'text-fg outline-none',
        'data-[selected=true]:bg-accent-subtle data-[selected=true]:text-accent',
        className,
      )}
      {...props}
    >
      {icon ? <span className="shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 truncate text-xs text-fg-muted">{hint}</span> : null}
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </CommandPrimitive.Item>
  )
})

export function CommandGroupHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
      {children}
    </div>
  )
}

// ─── InlineEdit ──────────────────────────────────────────────────────────────

export interface InlineEditProps {
  value: string
  onSave: (value: string) => void | Promise<void>
  placeholder?: string
  className?: string
  inputClassName?: string
  disabled?: boolean
  multiline?: boolean
  'aria-label'?: string
}

/** Правка на месте: клик → контрол → Enter сохраняет, Esc отменяет. */
export function InlineEdit({
  value,
  onSave,
  placeholder,
  className,
  inputClassName,
  disabled,
  multiline,
  ...props
}: InlineEditProps) {
  const t = useUiT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = async () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) await onSave(next)
    else setDraft(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={props['aria-label']}
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className={cn(
          'min-w-0 truncate rounded-sm px-1 text-left',
          !disabled && 'hover:bg-surface-3',
          !value && 'text-fg-muted',
          className,
        )}
      >
        {value || (placeholder ?? t('ui.untitled'))}
      </button>
    )
  }

  const Control = multiline ? 'textarea' : 'input'
  return (
    <Control
      autoFocus
      value={draft}
      aria-label={props['aria-label']}
      onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === 'Enter' && !multiline) {
          event.preventDefault()
          void commit()
        }
        if (event.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      }}
      className={cn(
        'min-w-0 rounded-sm border border-accent bg-surface px-1 outline-none',
        className,
        inputClassName,
      )}
    />
  )
}
