import type { DashboardFilter, DashboardRecord } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import { Badge, IconButton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { MapSlotsProvider } from '~/features/gis/index.js'
import { LazySituationBand } from '~/features/warnings/index.js'
import { meQuery, objectQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { BrandMark } from '~/shared/brand-mark.js'
import { useT } from '~/shared/i18n.js'
import {
  gridRows,
  orderedTiles,
  PERIOD_PRESETS,
  periodValue,
  tvRowHeight,
} from './dashboard-layout.js'
import { TileCard } from './dashboard-tile.js'
import { dashboardDataQuery } from './queries.js'

/** Автообновление в TV-режиме, если у дашборда своего интервала нет, секунд. */
const DEFAULT_REFRESH = 60
/** Часы и «обновлено N минут назад» перерисовываются раз в полминуты. */
const CLOCK_TICK = 30_000
/** Промежуток сетки плиток TV, px — тот же, что `gap-4`. */
const TV_GAP = 16

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
  const locale = useLocale()
  const { data: me } = useQuery(meQuery())
  const filterText = useFilterText()
  const root = useRef<HTMLDivElement>(null)
  const exit = useRef(onExit)
  exit.current = onExit
  const [now, setNow] = useState(() => new Date())
  const { data: space } = useQuery(objectQuery(dashboard.spaceId))
  // Высота строки — по высоте экрана: дашборд дежурной части виден целиком, без прокрутки
  const area = useRef<HTMLDivElement>(null)
  const [areaHeight, setAreaHeight] = useState(0)
  useEffect(() => {
    const element = area.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setAreaHeight(entry?.contentRect.height ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const tiles = orderedTiles(dashboard.spec.tiles)
  const rowHeight = tvRowHeight(areaHeight, gridRows(tiles), TV_GAP)

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
      <header className="flex shrink-0 items-center gap-6 px-8 pt-6 pb-2">
        <div className="flex min-w-0 shrink-0 items-center gap-4">
          <BrandMark size="lg" />
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-2xl text-fg">{dashboard.name}</h1>
            <span className="truncate text-md text-fg-muted">
              {[space?.title, t('common.appName')].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <Suspense fallback={null}>
            <LazySituationBand />
          </Suspense>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <time dateTime={now.toISOString()} className="tabular text-3xl text-fg">
            {formatClock(now, locale, timezone)}
          </time>
          <span className="font-mono text-xs tracking-wider text-fg-muted uppercase">
            {formatClockDate(now, locale, timezone)}
          </span>
        </div>
        <IconButton label={t('data.dashboard.tv.exit')} onClick={() => exit.current()} autoFocus>
          <X className="size-5" />
        </IconButton>
      </header>
      {chips.length > 0 || data.dataUpdatedAt ? (
        <div className="flex shrink-0 items-center gap-3 px-8 pb-1">
          {chips.map((chip) => (
            <Badge key={chip.id} tone="outline">
              {t('data.dashboard.tv.filter', { label: chip.label, value: chip.text })}
            </Badge>
          ))}
          <span className="flex-1" />
          {data.dataUpdatedAt ? (
            <span className="text-sm text-fg-secondary">
              {t('data.dashboard.updated', {
                time: formatRelativeTime(new Date(Math.min(data.dataUpdatedAt, now.getTime())), {
                  locale,
                }),
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      <div ref={area} className="min-h-0 flex-1 overflow-auto px-8 pt-3 pb-6">
        <MapSlotsProvider>
          <div className="grid grid-cols-12 gap-4" style={{ gridAutoRows: `${rowHeight}px` }}>
            {tiles.map((tile) => (
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
                rowHeight={rowHeight}
                rowGap={TV_GAP}
                refreshMs={refreshMs}
              />
            ))}
          </div>
        </MapSlotsProvider>
      </div>
    </div>
  )
}

/** Часы ситуационного экрана: «14:32» в поясе сотрудника. */
function formatClock(now: Date, locale: string, timezone: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(now)
}

/** Строка под часами: день недели, дата и смещение пояса — «ср, 05.11.2026 · GMT+5». */
function formatClockDate(now: Date, locale: string, timezone: string | undefined): string {
  const zone = timezone ? { timeZone: timezone } : {}
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...zone,
  }).format(now)
  const offset = new Intl.DateTimeFormat(locale, { timeZoneName: 'shortOffset', ...zone })
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')?.value
  return offset ? `${date} · ${offset}` : date
}
