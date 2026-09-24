import type { DashboardFilter, DashboardRecord } from '@kchs/contracts'
import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import { Badge, IconButton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { MapSlotsProvider } from '~/features/gis/map-slots.js'
import { meQuery } from '~/shared/api/queries.js'
import { orderedTiles, PERIOD_PRESETS, periodValue } from './dashboard-layout.js'
import { TileCard } from './dashboard-tile.js'
import { dashboardDataQuery } from './queries.js'

/** Автообновление в TV-режиме, если у дашборда своего интервала нет, секунд. */
const DEFAULT_REFRESH = 60
/** Часы и «обновлено N минут назад» перерисовываются раз в полминуты. */
const CLOCK_TICK = 30_000

const noop = () => undefined

/** Значение фильтра только для чтения: в TV выпадающие списки не показать. */
function useFilterText() {
  const t = useT()
  return (filter: DashboardFilter, value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (filter.kind === 'period') {
      const preset = PERIOD_PRESETS.find(
        (item) => JSON.stringify(periodValue(item)) === JSON.stringify(value),
      )
      return preset ? t(`data.dashboard.periods.${preset}`) : null
    }
    return Array.isArray(value) ? value.join(', ') : String(value)
  }
}

/**
 * TV-режим дашборда (06-analytics-engine.md §9, ADR-0058): поверх оболочки, в
 * тёмной теме и на весь экран; плитки и числа крупнее, данные обновляются сами,
 * вверху — часы и «обновлено N минут назад». Выход — Esc или кнопка; фильтры —
 * те, что были выбраны, только для чтения.
 */
export function DashboardTv({
  dashboard,
  values,
  onExit,
}: {
  dashboard: DashboardRecord
  values: Record<string, unknown>
  onExit: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const filterText = useFilterText()
  const root = useRef<HTMLDivElement>(null)
  const exit = useRef(onExit)
  exit.current = onExit
  const [now, setNow] = useState(() => new Date())

  const refreshMs = (dashboard.spec.refreshInterval ?? DEFAULT_REFRESH) * 1000
  const data = useQuery({
    ...dashboardDataQuery(dashboard.id, values),
    refetchInterval: refreshMs,
    refetchIntervalInBackground: true,
  })

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK)
    return () => window.clearInterval(timer)
  }, [])

  // Полный экран, если браузер позволяет; вышли из него (Esc) — выходим из TV
  useEffect(() => {
    root.current?.requestFullscreen?.().catch(() => undefined)
    const onFullscreen = () => {
      if (!document.fullscreenElement) exit.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exit.current()
    }
    document.addEventListener('fullscreenchange', onFullscreen)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen)
      window.removeEventListener('keydown', onKey)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  const timezone = me?.user.timezone
  const chips = dashboard.spec.filters.flatMap((filter) => {
    const text = filterText(filter, filter.id in values ? values[filter.id] : filter.default)
    return text ? [{ id: filter.id, label: filter.label[locale] ?? filter.label.ru, text }] : []
  })

  return (
    <div
      ref={root}
      data-theme="dark"
      role="dialog"
      aria-modal="true"
      aria-label={t('data.dashboard.tv.title', { name: dashboard.name })}
      className="fixed inset-0 z-(--z-overlay) flex flex-col bg-canvas text-fg"
    >
      <header className="flex shrink-0 items-center gap-4 border-b border-line px-6 py-3">
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold text-fg">{dashboard.name}</h1>
        {chips.map((chip) => (
          <Badge key={chip.id} tone="outline">
            {t('data.dashboard.tv.filter', { label: chip.label, value: chip.text })}
          </Badge>
        ))}
        {data.dataUpdatedAt ? (
          <span className="text-sm text-fg-secondary">
            {t('data.dashboard.updated', {
              time: formatRelativeTime(new Date(Math.min(data.dataUpdatedAt, now.getTime())), {
                locale,
              }),
            })}
          </span>
        ) : null}
        <time dateTime={now.toISOString()} className="tabular text-lg font-semibold text-fg">
          {formatDateTime(now, { locale, ...(timezone ? { timezone } : {}) })}
        </time>
        <IconButton label={t('data.dashboard.tv.exit')} onClick={() => exit.current()} autoFocus>
          <X className="size-5" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <MapSlotsProvider>
          <div className="grid auto-rows-[112px] grid-cols-12 gap-4">
            {orderedTiles(dashboard.spec.tiles).map((tile) => (
              <TileCard
                key={tile.id}
                tile={tile}
                data={data.data?.tiles[tile.id]}
                pending={data.isFetching}
                editing={false}
                filters={dashboard.spec.filters}
                values={values}
                onChange={noop}
                onMove={noop}
                onRemove={noop}
                large
                refreshMs={refreshMs}
              />
            ))}
          </div>
        </MapSlotsProvider>
      </div>
    </div>
  )
}
