import { cva, type VariantProps } from 'class-variance-authority'
import { AlertCircle, CheckCircle2, Info, Loader2, Lock, TriangleAlert, X } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { cn } from '../lib/cn.js'
import { Button, IconButton } from '../primitives/button.js'

// ─── Skeleton ────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse-soft rounded-xs bg-surface-3', className)} />
}

/** Скелетон таблицы: повторяет форму контента, а не спиннер. */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-px" aria-hidden>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex h-[var(--row-h)] items-center gap-4 px-3"
          style={{ opacity: 1 - rowIndex * 0.07 }}
        >
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-3', columnIndex === 0 ? 'w-[28%]' : 'w-[14%]')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label ?? 'Загрузка'} className="inline-flex">
      <Loader2 className={cn('size-4 animate-spin-fast text-fg-muted', className)} />
    </span>
  )
}

export function ProgressBar({
  value,
  max = 1,
  className,
  label,
  showValue,
}: {
  value: number
  max?: number
  className?: string
  label?: string
  showValue?: boolean
}) {
  const percent = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[var(--duration-slow)] ease-standard"
          style={{ width: `${percent}%` }}
        />
      </div>
      {showValue ? (
        <span className="tabular text-2xs text-fg-muted">{Math.round(percent)}%</span>
      ) : null}
    </div>
  )
}

// ─── Callout ─────────────────────────────────────────────────────────────────

const calloutVariants = cva('flex gap-2.5 rounded-md border p-3 text-sm', {
  variants: {
    tone: {
      info: 'border-line bg-info-subtle text-fg',
      success: 'border-line bg-success-subtle text-fg',
      warning: 'border-line bg-warning-subtle text-fg',
      danger: 'border-line bg-danger-subtle text-fg',
      neutral: 'border-line bg-surface-2 text-fg',
    },
  },
  defaultVariants: { tone: 'info' },
})

const calloutIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
  neutral: Info,
}

export interface CalloutProps extends VariantProps<typeof calloutVariants> {
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
  onDismiss?: () => void
}

export function Callout({
  tone = 'info',
  title,
  children,
  action,
  className,
  onDismiss,
}: CalloutProps) {
  const Icon = calloutIcons[tone ?? 'info']
  const iconTone = {
    info: 'text-info',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    neutral: 'text-fg-muted',
  }[tone ?? 'info']

  return (
    <div
      className={cn(calloutVariants({ tone }), className)}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', iconTone)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? (
          <div className={cn('text-fg-secondary', title && 'mt-0.5')}>{children}</div>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton label="Скрыть" size="sm" onClick={onDismiss}>
          <X className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  )
}

// ─── Пустые состояния и ошибки ──────────────────────────────────────────────

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-16',
        className,
      )}
    >
      {icon ? (
        <div className="flex size-11 items-center justify-center rounded-lg bg-surface-2 text-fg-muted [&_svg]:size-6">
          {icon}
        </div>
      ) : null}
      <div className={cn('font-medium text-fg', compact ? 'text-sm' : 'text-md')}>{title}</div>
      {description ? (
        <div className="max-w-[46ch] text-sm text-fg-secondary">{description}</div>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function ErrorState({
  title = 'Не удалось загрузить',
  description,
  onRetry,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  onRetry?: () => void
  className?: string
}) {
  return (
    <EmptyState
      className={className}
      icon={<AlertCircle className="text-danger" />}
      title={title}
      description={description}
      action={
        onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            Повторить
          </Button>
        ) : null
      }
    />
  )
}

export function NoAccessState({
  onRequest,
  className,
}: {
  onRequest?: () => void
  className?: string
}) {
  return (
    <EmptyState
      className={className}
      icon={<Lock />}
      title="Нет доступа"
      description="У вас нет прав на просмотр этого объекта. Можно запросить доступ у владельца."
      action={
        onRequest ? (
          <Button variant="secondary" onClick={onRequest}>
            Запросить доступ
          </Button>
        ) : null
      }
    />
  )
}

// ─── Toast ───────────────────────────────────────────────────────────────────

export interface ToastOptions {
  id?: string
  title: ReactNode
  description?: ReactNode
  tone?: 'info' | 'success' | 'warning' | 'danger'
  /** Действие «Отменить» вместо подтверждения (04-interaction-patterns.md §9). */
  action?: { label: string; onClick: () => void }
  /** Ошибки не исчезают до закрытия. */
  duration?: number
}

interface ToastEntry extends ToastOptions {
  id: string
}

interface ToastApi {
  show: (options: ToastOptions) => string
  dismiss: (id: string) => void
  success: (title: ReactNode, description?: ReactNode) => string
  error: (title: ReactNode, description?: ReactNode) => string
}

const ToastContext = createContext<ToastApi | null>(null)

const MAX_VISIBLE = 3

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id))
  }, [])

  const show = useCallback((options: ToastOptions) => {
    const id = options.id ?? `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { ...options, id }])
    return id
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, tone: 'success' }),
      error: (title, description) => show({ title, description, tone: 'danger', duration: 0 }),
    }),
    [show, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-(--z-toast) flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: string) => void }) {
  const duration = toast.duration ?? (toast.action ? 8000 : 5000)

  useEffect(() => {
    if (duration <= 0) return
    const timer = setTimeout(() => onDismiss(toast.id), duration)
    return () => clearTimeout(timer)
  }, [duration, onDismiss, toast.id])

  const toneClass = {
    info: 'border-line',
    success: 'border-success/40',
    warning: 'border-warning/40',
    danger: 'border-danger/50',
  }[toast.tone ?? 'info']

  return (
    <div
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-md border bg-overlay p-3 shadow-lg',
        'animate-slide-up',
        toneClass,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{toast.title}</div>
        {toast.description ? (
          <div className="mt-0.5 text-xs text-fg-secondary">{toast.description}</div>
        ) : null}
      </div>
      {toast.action ? (
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            toast.action?.onClick()
            onDismiss(toast.id)
          }}
        >
          {toast.action.label}
        </Button>
      ) : null}
      <IconButton label="Закрыть" size="sm" onClick={() => onDismiss(toast.id)}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast должен использоваться внутри ToastProvider')
  return context
}
