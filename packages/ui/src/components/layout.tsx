import type { ReactNode } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { cn } from '../lib/cn.js'

export { Panel, PanelGroup }

/** Разделитель панелей: тонкий, подсвечивается при наведении и перетаскивании. */
export function ResizeHandle({
  direction = 'vertical',
  className,
}: {
  direction?: 'vertical' | 'horizontal'
  className?: string
}) {
  return (
    <PanelResizeHandle
      className={cn(
        'group relative shrink-0 bg-line transition-colors',
        'data-[resize-handle-state=drag]:bg-accent data-[resize-handle-state=hover]:bg-accent/60',
        direction === 'vertical' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute',
          direction === 'vertical' ? '-inset-x-1 inset-y-0' : '-inset-y-1 inset-x-0',
        )}
      />
    </PanelResizeHandle>
  )
}

/** Тулбар панели: 3–6 главных действий, остальное — в «⋯». */
export function PanelToolbar({
  left,
  right,
  className,
}: {
  left?: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-2.5',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
      <div className="flex shrink-0 items-center gap-1">{right}</div>
    </div>
  )
}

export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-fg-secondary">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
