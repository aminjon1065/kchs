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
  /** `lg` — крупные значение и подписи: TV-режим дашборда, экран на стене. */
  size?: 'md' | 'lg'
  className?: string
  onClick?: () => void
}

/**
 * Показатель (тип графика `number`): значение, дельта со знаком — цвет по тому,
 * хорошо ли изменение для показателя, плюс стрелка и подпись (не только цвет),
 * цель с прогрессом, отметка порога и искра истории.
 */
export function NumberTile({ model, size = 'md', className, onClick }: NumberTileProps) {
  const t = useUiT()
  const large = size === 'lg'
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
          <span
            className={cn('shrink-0 rounded-full', large ? 'size-3' : 'size-2', STATUS_DOT[status])}
          >
            <span className="sr-only">{t('ui.chart.tile.status')}</span>
          </span>
        ) : null}
        <span className={cn('truncate text-fg-secondary', large ? 'text-md' : 'text-xs')}>
          {model.label}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          // leading-none — после размера: tailwind-merge снимает высоту строки перед text-*
          className={cn(
            'tabular font-semibold text-fg',
            large ? 'text-3xl' : 'text-2xl',
            'leading-none',
          )}
        >
          {model.formatted}
        </span>
        {model.unit ? (
          <span className={cn('text-fg-muted', large ? 'text-md' : 'text-xs')}>{model.unit}</span>
        ) : null}
      </div>
      {delta ? (
        <div className={cn('flex items-center gap-1', large ? 'text-base' : 'text-xs', tone)}>
          <Arrow className={cn('shrink-0', large ? 'size-5' : 'size-3.5')} aria-hidden />
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
