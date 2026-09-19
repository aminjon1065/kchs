import type { MouseEvent, ReactNode } from 'react'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'

export interface AvailabilityInterval {
  /** Моменты, мс. */
  start: number
  end: number
  /** «Возможно» или ещё без ответа — штриховка. */
  tentative?: boolean
  /** Название, если детали видны; иначе — просто «занято». */
  title?: string | null
}

export interface AvailabilityRow {
  key: string
  label: ReactNode
  sublabel?: ReactNode
  /** Аватар или значок ресурса. */
  icon?: ReactNode
  busy: AvailabilityInterval[]
  /** Рабочее время участника; вне его — приглушённый фон. */
  working?: Array<{ start: number; end: number }>
}

export interface AvailabilityGridProps {
  /** Показанный промежуток, мс. */
  start: number
  end: number
  /** Отметки шкалы: момент и подпись («09:00»). */
  ticks: Array<{ at: number; label: string }>
  rows: AvailabilityRow[]
  /** Время встречи — рамка поверх всех строк. */
  selection?: { start: number; end: number } | null
  /** Предложенные окна — отметки на шкале. */
  suggestions?: Array<{ start: number; end: number }>
  /** Щелчок по шкале — начало встречи (мс). */
  onPick?: (at: number) => void
  /** Подпись промежутка для подсказок и скринридера («10:00–11:00»). */
  formatRange: (start: number, end: number) => string
  'aria-label': string
  className?: string
}

/**
 * Сетка занятости для подбора времени: строки — участники и ресурсы,
 * по горизонтали — время дня; занятость без деталей там, где детали скрыты,
 * рамка — выбранное время, отметки — свободные окна. Щелчок по шкале
 * переносит встречу.
 */
export function AvailabilityGrid({
  start,
  end,
  ticks,
  rows,
  selection = null,
  suggestions = [],
  onPick,
  formatRange,
  className,
  ...props
}: AvailabilityGridProps) {
  const t = useUiT()
  const span = Math.max(1, end - start)
  const percent = (at: number) => `${((Math.min(end, Math.max(start, at)) - start) / span) * 100}%`
  const width = (from: number, to: number) =>
    `${((Math.min(end, to) - Math.max(start, from)) / span) * 100}%`
  const visible = (item: { start: number; end: number }) => item.end > start && item.start < end

  const pick = (event: MouseEvent<HTMLElement>) => {
    if (!onPick) return
    const rect = event.currentTarget.getBoundingClientRect()
    onPick(start + ((event.clientX - rect.left) / rect.width) * span)
  }

  return (
    <section
      aria-label={props['aria-label']}
      className={cn('flex flex-col overflow-hidden rounded-md border border-line', className)}
    >
      <div className="flex border-b border-line bg-surface-2">
        <div className="w-48 shrink-0" />
        <div className="relative h-7 flex-1">
          {suggestions.filter(visible).map((item) => (
            <span
              key={`${item.start}`}
              aria-hidden
              className="absolute bottom-0 h-1.5 rounded-t-xs bg-success"
              style={{ left: percent(item.start), width: width(item.start, item.end) }}
            />
          ))}
          {ticks.map((tick) => (
            <span
              key={tick.at}
              className="tabular absolute top-1 -translate-x-1/2 text-2xs text-fg-muted"
              style={{ left: percent(tick.at) }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <ul className="relative flex flex-col">
        {rows.map((row) => (
          <li key={row.key} className="flex min-h-10 border-b border-line last:border-b-0">
            <div className="flex w-48 shrink-0 items-center gap-2 border-r border-line px-2 py-1">
              {row.icon}
              <span className="min-w-0">
                <span className="block truncate text-sm text-fg">{row.label}</span>
                {row.sublabel ? (
                  <span className="block truncate text-2xs text-fg-muted">{row.sublabel}</span>
                ) : null}
              </span>
              <span className="sr-only">
                {row.busy.length === 0
                  ? t('ui.calendar.free')
                  : row.busy
                      .map((item) =>
                        t(item.tentative ? 'ui.calendar.tentativeAt' : 'ui.calendar.busyAt', {
                          range: formatRange(item.start, item.end),
                        }),
                      )
                      .join('; ')}
              </span>
            </div>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={pick}
              className={cn(
                'relative flex-1 bg-surface-2',
                onPick ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              {(row.working ?? []).filter(visible).map((item) => (
                <span
                  key={`w${item.start}`}
                  className="absolute inset-y-0 bg-surface"
                  style={{ left: percent(item.start), width: width(item.start, item.end) }}
                />
              ))}
              {ticks.map((tick) => (
                <span
                  key={`t${tick.at}`}
                  className="absolute inset-y-0 border-l border-line"
                  style={{ left: percent(tick.at) }}
                />
              ))}
              {row.busy.filter(visible).map((item) => (
                <span
                  key={`b${item.start}-${item.end}`}
                  title={`${formatRange(item.start, item.end)}${item.title ? ` · ${item.title}` : ''}`}
                  className={cn(
                    'absolute inset-y-1.5 rounded-xs',
                    item.tentative ? 'kchs-calendar-hatch bg-accent-subtle' : 'bg-accent',
                  )}
                  style={{ left: percent(item.start), width: width(item.start, item.end) }}
                />
              ))}
            </button>
          </li>
        ))}
        {selection && visible(selection) ? (
          <li aria-hidden className="pointer-events-none absolute inset-y-0 left-48 right-0">
            <span
              className="absolute inset-y-0 rounded-xs border-2 border-success"
              style={{
                left: percent(selection.start),
                width: width(selection.start, selection.end),
              }}
            />
          </li>
        ) : null}
      </ul>
    </section>
  )
}
