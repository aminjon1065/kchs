import type { ChartColorToken, NumberTileModel } from '@kchs/chart-spec'
import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { Sparkline } from '../components/data-display.js'
import { ProgressBar } from '../components/feedback.js'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'

/** Цвет порога — семантический токен дизайн-системы. */
const STATUS_DOT: Record<ChartColorToken, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-fg-muted',
  purple: 'bg-purple',
}

export interface NumberTileProps {
  model: NumberTileModel
  className?: string
  onClick?: () => void
}

/**
 * Показатель (тип графика `number`): значение, дельта со знаком — цвет по тому,
 * хорошо ли изменение для показателя, плюс стрелка и подпись (не только цвет),
 * цель с прогрессом, отметка порога и искра истории.
 */
export function NumberTile({ model, className, onClick }: NumberTileProps) {
  const t = useUiT()
  const { delta, target, status } = model
  const tone =
    delta?.good === true
      ? 'text-success'
      : delta?.good === false
        ? 'text-danger'
        : 'text-fg-secondary'
  const Arrow =
    delta?.direction === 'up' ? TrendingUp : delta?.direction === 'down' ? TrendingDown : Minus

  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-surface p-[var(--card-pad)]',
        onClick && 'cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2',
        className,
      )}
      {...(onClick
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            },
          }
        : {})}
    >
      <div className="flex items-center gap-1.5">
        {status ? (
          <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])}>
            <span className="sr-only">{t('ui.chart.tile.status')}</span>
          </span>
        ) : null}
        <span className="truncate text-xs text-fg-secondary">{model.label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-2xl font-semibold leading-none text-fg">
          {model.formatted}
        </span>
        {model.unit ? <span className="text-xs text-fg-muted">{model.unit}</span> : null}
      </div>
      {delta ? (
        <div className={cn('flex items-center gap-1 text-xs', tone)}>
          <Arrow className="size-3.5 shrink-0" aria-hidden />
          <span className="tabular">{delta.formatted}</span>
          <span className="truncate text-fg-muted">{delta.label}</span>
        </div>
      ) : null}
      {target ? (
        <div className="flex flex-col gap-1">
          <ProgressBar value={Math.min(1, Math.max(0, target.progress))} label={target.label} />
          <span className="text-2xs text-fg-muted">{target.label}</span>
        </div>
      ) : null}
      {model.spark.length > 1 ? <Sparkline values={model.spark} /> : null}
    </div>
  )
}
