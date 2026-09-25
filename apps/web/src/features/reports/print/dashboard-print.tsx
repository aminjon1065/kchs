import type {
  DashboardData,
  DashboardFilter,
  DashboardRecord,
  DashboardTile,
  DashboardTileData,
  Locale,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { Button, Chart, cn, ErrorState, NumberTile, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { metricTileModel, periodText } from '~/features/data/metric-format.js'
import { useLabelledResult } from '~/features/gis/result-labels.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'
import { PrintMap } from './print-blocks.js'
import { type PrintContextValue, PrintProvider, setPrintState, settleDom } from './print-context.js'

/** Высота строки сетки на листе, px: плитка в 4 строки — около четверти альбомного A4. */
const ROW = 56
/** Карта, которая так и не дорисовалась, не держит печать дольше. */
const MAPS_LIMIT_MS = 45_000
/** Классы размеров плитки — литералами, чтобы Tailwind их собрал (без встроенных стилей, CSP). */
const COL_SPAN = [
  '',
  'col-span-1',
  'col-span-2',
  'col-span-3',
  'col-span-4',
  'col-span-5',
  'col-span-6',
  'col-span-7',
  'col-span-8',
  'col-span-9',
  'col-span-10',
  'col-span-11',
  'col-span-12',
]

/** Значение фильтра строкой — только простые значения; период и территория — подписью фильтра. */
function filterText(filter: DashboardFilter, value: unknown, locale: Locale): string | null {
  const label = filter.label[locale] ?? filter.label.ru ?? filter.id
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) {
    const simple = value.filter((item) => typeof item === 'string' || typeof item === 'number')
    return simple.length > 0 ? `${label}: ${simple.join(', ')}` : label
  }
  if (typeof value === 'string' || typeof value === 'number') return `${label}: ${value}`
  return label
}

function TileBody({
  tile,
  data,
  timezone,
}: {
  tile: DashboardTile
  data: DashboardTileData | undefined
  timezone: string
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const result = useLabelledResult(data?.result ?? undefined)
  if (tile.kind === 'text' || tile.kind === 'heading') {
    return <div className="h-full overflow-hidden whitespace-pre-wrap text-sm">{tile.text}</div>
  }
  if (tile.kind === 'map') {
    if (!tile.mapId) return null
    return (
      <PrintMap
        block={{
          id: tile.id,
          kind: 'map',
          title: null,
          source: 'map',
          mapId: tile.mapId,
          layerId: null,
          camera: tile.map?.camera ?? null,
          size: tile.h >= 5 ? 'large' : 'medium',
          legend: false,
        }}
      />
    )
  }
  if (data?.error === 'no_access') {
    return <p className="text-xs text-fg-muted">{t('data.report.print.noAccess')}</p>
  }
  if (data?.error) return <p className="text-xs text-fg-muted">{t('data.dashboard.failed')}</p>
  if (tile.kind === 'metric' && data?.metric) {
    return (
      <NumberTile
        model={metricTileModel(data.metric, t, locale, periodText(data.metric.period, t, locale))}
        className="h-full border-0 bg-transparent p-0"
      />
    )
  }
  if (data?.spec && result) {
    return (
      <Chart
        spec={data.spec}
        result={result}
        height={Math.max(tile.h * ROW - 48, 120)}
        animation={false}
        timezone={timezone}
      />
    )
  }
  return null
}

/**
 * Лист печати дашборда (ADR-0159): та же сетка 12 колонок, плитки с фильтрами,
 * выбранными на экране, данные — теми же маршрутами с правами смотрящего.
 * Графики рисуются без анимации, карты снимаются в картинку (как в отчёте,
 * ADR-0078); когда всё дорисовано — `data-print-state="ready"` и окно печати
 * браузера, где лист сохраняют в PDF.
 */
function DashboardSheet({
  dashboard,
  data,
  filters,
  timezone,
}: {
  dashboard: DashboardRecord
  data: DashboardData
  filters: Record<string, unknown>
  timezone: string
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const tiles = useMemo(
    () =>
      [...dashboard.spec.tiles]
        .filter((tile) => tile.kind !== 'filter')
        .sort((a, b) => a.y - b.y || a.x - b.x),
    [dashboard.spec.tiles],
  )
  const maps = useMemo(
    () => tiles.filter((tile) => tile.kind === 'map' && tile.mapId).map((tile) => tile.id),
    [tiles],
  )
  const [ready, setReady] = useState<ReadonlySet<string>>(new Set())
  const [mapsTimedOut, setMapsTimedOut] = useState(false)
  const printed = useRef(false)
  const [generatedAt] = useState(() => new Date())

  const report = useCallback((blockId: string) => {
    setReady((current) => (current.has(blockId) ? current : new Set(current).add(blockId)))
  }, [])
  const context = useMemo<PrintContextValue>(
    () => ({ params: { period: null, territory: null }, timezone, locale, canSql: false, report }),
    [timezone, locale, report],
  )

  useEffect(() => {
    document.title = dashboard.name
    const timer = window.setTimeout(() => setMapsTimedOut(true), MAPS_LIMIT_MS)
    return () => window.clearTimeout(timer)
  }, [dashboard.name])

  const all = mapsTimedOut || maps.every((id) => ready.has(id))
  useEffect(() => {
    if (!all || printed.current) return
    let cancelled = false
    void settleDom().then(() => {
      if (cancelled) return
      printed.current = true
      setPrintState('ready')
      // Окно печати — сразу, как лист готов; у браузера автотестов его нет
      if (!navigator.webdriver) window.print()
    })
    return () => {
      cancelled = true
    }
  }, [all])

  const applied = dashboard.spec.filters
    .map((filter) =>
      filterText(filter, filter.id in filters ? filters[filter.id] : filter.default, locale),
    )
    .filter((text): text is string => text !== null)
  const subtitle = [
    t('data.dashboard.printPage.generated', {
      date: formatDateTime(generatedAt, { locale, timezone }),
    }),
    ...(applied.length > 0
      ? [t('data.dashboard.printPage.filters', { list: applied.join('; ') })]
      : []),
  ].join(' · ')

  let body: ReactNode
  if (tiles.length === 0) {
    body = <p className="text-sm text-fg-muted">{t('data.dashboard.empty')}</p>
  } else {
    body = (
      <div className="grid grid-cols-12 gap-3">
        {tiles.map((tile) => (
          <section
            key={tile.id}
            aria-label={tile.title ?? undefined}
            className={cn(
              COL_SPAN[tile.w] ?? 'col-span-6',
              'flex min-w-0 break-inside-avoid flex-col gap-1.5 rounded-md border border-line p-2.5',
            )}
          >
            {tile.title && tile.kind !== 'heading' ? (
              <h2 className="truncate text-sm font-semibold text-fg">{tile.title}</h2>
            ) : null}
            <TileBody tile={tile} data={data.tiles[tile.id]} timezone={timezone} />
          </section>
        ))}
      </div>
    )
  }

  return (
    <PrintProvider value={context}>
      <article className="mx-auto flex max-w-[1180px] flex-col gap-4 bg-surface p-6 text-fg print:max-w-none print:p-0">
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2 print:hidden">
          <p className="text-xs text-fg-secondary">{t('data.dashboard.printPage.hint')}</p>
          <Button
            variant="primary"
            size="sm"
            icon={<Printer className="size-3.5" />}
            onClick={() => window.print()}
          >
            {t('data.dashboard.printPage.print')}
          </Button>
        </div>
        <header className="flex flex-col gap-1 border-b border-line pb-3">
          <h1 className="text-xl font-semibold text-fg">{dashboard.name}</h1>
          <p className="text-xs text-fg-secondary">{subtitle}</p>
        </header>
        {maps.length > 0 && dashboard.spec.filters.length > 0 ? (
          <p className="text-2xs text-fg-muted">{t('data.dashboard.printPage.mapFilters')}</p>
        ) : null}
        {body}
      </article>
    </PrintProvider>
  )
}

/** Страница печати дашборда вне оболочки: `/print/dashboard/<id>?filters=…` (новая вкладка). */
export function DashboardPrint({
  dashboardId,
  filters,
}: {
  dashboardId: string
  filters: Record<string, unknown>
}) {
  const t = useT()
  // Сессия пользователя: CSRF-токен из /me нужен POST-запросу данных плиток
  const me = useQuery({
    queryKey: ['print', 'me'],
    queryFn: () =>
      http
        .get<{ session: { csrfToken: string }; user: { timezone: string } }>('/me', {
          anonymous: true,
        })
        .catch(() => null),
    retry: false,
  })
  useEffect(() => {
    if (me.data?.session.csrfToken) setCsrfToken(me.data.session.csrfToken)
  }, [me.data])
  const dashboard = useQuery({
    queryKey: ['print', 'dashboard', dashboardId],
    queryFn: () => http.get<DashboardRecord>(`/dashboards/${dashboardId}`, { anonymous: true }),
    enabled: !me.isLoading,
    retry: false,
  })
  const data = useQuery({
    queryKey: ['print', 'dashboard', dashboardId, 'data', filters],
    queryFn: () =>
      http.post<DashboardData>(`/dashboards/${dashboardId}/data`, { filters }, { anonymous: true }),
    enabled: Boolean(me.data) && Boolean(dashboard.data),
    retry: false,
  })

  // Бумага: светлая тема, плотные строки и альбомный лист — только на этой странице
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = 'light'
    root.dataset.density = 'compact'
    root.dataset.print = 'dashboard'
    return () => {
      delete root.dataset.print
    }
  }, [])

  const error = dashboard.error ?? data.error ?? (me.isSuccess && !me.data ? true : null)
  useEffect(() => {
    if (error) setPrintState('error')
  }, [error])

  if (error) {
    return (
      <ErrorState
        title={t('data.dashboard.printPage.unavailable')}
        description={error instanceof ApiError ? error.message : undefined}
      />
    )
  }
  if (!dashboard.data || !data.data || !me.data) {
    return (
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  return (
    <DashboardSheet
      dashboard={dashboard.data}
      data={data.data}
      filters={filters}
      timezone={me.data.user.timezone}
    />
  )
}
