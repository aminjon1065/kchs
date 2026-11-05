import { Check, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

export type RouteStepState = 'done' | 'current' | 'upcoming' | 'rejected'

export interface RouteStepperStep {
  key: string
  title: ReactNode
  /** Кто решает: назначенные, «вы», подразделение. */
  people?: ReactNode
  /** Время, норма и остаток — моноширинно. */
  meta?: ReactNode
  /** Смысл строки времени: в норме, просрочено, ваш срок. */
  metaTone?: 'muted' | 'success' | 'danger' | 'accent'
  state: RouteStepState
}

const META_TONE = {
  muted: 'text-fg-muted',
  success: 'text-success',
  danger: 'text-danger',
  accent: 'text-accent',
} as const

/** Знак шага: пройден, текущий, впереди, отклонён. */
function Marker({ state }: { state: RouteStepState }) {
  if (state === 'done') {
    return (
      <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success ring-1 ring-success">
        <Check className="size-3" strokeWidth={3} aria-hidden />
      </span>
    )
  }
  if (state === 'rejected') {
    return (
      <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-danger-subtle text-danger ring-1 ring-danger">
        <X className="size-3" strokeWidth={3} aria-hidden />
      </span>
    )
  }
  if (state === 'current') {
    return (
      <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full border-2 border-accent bg-surface ring-4 ring-accent-subtle">
        <span className="size-2 rounded-full bg-accent" />
      </span>
    )
  }
  return <span className="size-5.5 shrink-0 rounded-full border-2 border-line-strong bg-surface" />
}

/**
 * Маршрут документа шагами по горизонтали (ADR-0230): кто, когда, норма и остаток
 * времени; текущий шаг выделен, пройденные отмечены, отклонённый — крестом. Состояние
 * шага читается и словом для экранного диктора, не только цветом.
 */
export function RouteStepper({
  steps,
  className,
  ...props
}: {
  steps: RouteStepperStep[]
  className?: string
  'aria-label'?: string
}) {
  const t = useUiT()
  return (
    <ol aria-label={props['aria-label']} className={cn('flex min-w-0', className)}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1
        const passed = step.state === 'done'
        return (
          <li
            key={step.key}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className={cn('flex min-w-0 flex-1 basis-0 flex-col gap-2', !last && 'pr-3')}
          >
            <span className="flex items-center gap-2">
              <Marker state={step.state} />
              {last ? null : (
                <span
                  aria-hidden
                  className={cn(
                    'h-0.5 flex-1 rounded-full',
                    passed ? 'bg-success' : 'bg-line-strong',
                  )}
                />
              )}
            </span>
            <span
              className={cn(
                'truncate text-sm',
                step.state === 'current'
                  ? 'font-semibold text-accent'
                  : step.state === 'upcoming'
                    ? 'font-medium text-fg-secondary'
                    : 'font-semibold text-fg',
              )}
            >
              {step.title}
              <span className="sr-only">
                {' — '}
                {t(`ui.stepper.${step.state}`)}
              </span>
            </span>
            {step.people ? (
              <span
                className={cn(
                  'truncate text-xs',
                  step.state === 'upcoming' ? 'text-fg-muted' : 'text-fg-secondary',
                )}
              >
                {step.people}
              </span>
            ) : null}
            {step.meta ? (
              <span
                className={cn(
                  'tabular truncate font-mono text-2xs',
                  META_TONE[step.metaTone ?? 'muted'],
                )}
              >
                {step.meta}
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
