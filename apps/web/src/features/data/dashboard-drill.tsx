import type { ChartPick } from '@kchs/chart-spec'
import type {
  ChartSpec,
  DashboardDrillResult,
  DashboardFilter,
  DashboardTile,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  DataGrid,
  type DataGridColumn,
  Sheet,
  SheetContent,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Filter, Table2 } from 'lucide-react'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'

/** Служебные столбцы строки и вычисляемые поля детализации — не для глаз. */
const HIDDEN = (name: string) => name === '_id' || name === '_ver' || name.startsWith('__drill_')

type Aggregate = Extract<
  Extract<ChartSpec['data'], { query: unknown }>['query']['steps'][number],
  { type: 'aggregate' }
>

/**
 * Перекрёстный фильтр: выбранный элемент — значение разреза, к полю которого
 * плитка привязана фильтром дашборда. Интервалы времени и меры не подходят.
 */
export function crossFilterFor(
  spec: ChartSpec | null,
  tile: DashboardTile,
  filters: DashboardFilter[],
  pick: ChartPick,
): { filterId: string; value: string } | null {
  const query = spec && 'query' in spec.data ? spec.data.query : null
  if (!query) return null
  const aggregate = query.steps.find((step): step is Aggregate => step.type === 'aggregate')
  for (const condition of pick.filters) {
    if (condition.op !== 'eq' || condition.value === null || condition.value === undefined) continue
    const group = aggregate?.groupBy.find(
      (item) =>
        (item.alias ?? (item.bucket ? `${item.field}_${item.bucket}` : item.field)) ===
        condition.field,
    )
    if (aggregate && (!group || group.bucket)) continue
    const field = group?.field ?? condition.field
    const filter = filters.find(
      (item) =>
        (item.kind === 'select' || item.kind === 'text') &&
        tile.filterBindings?.[item.id] === field,
    )
    if (filter) return { filterId: filter.id, value: String(condition.value) }
  }
  return null
}

/**
 * Детализация плитки до строк (06-analytics-engine.md «Дашборды»): щелчок по
 * элементу графика — строки источника под условиями графика, фильтрами
 * дашборда и выбранным элементом, с политиками смотрящего.
 */
export function DrillSheet({
  dashboardId,
  tile,
  spec,
  pick,
  values,
  filters,
  onFilter,
  onClose,
}: {
  dashboardId: string
  tile: DashboardTile
  spec: ChartSpec | null
  pick: ChartPick
  /** Текущие значения фильтров дашборда. */
  values: Record<string, unknown>
  filters: DashboardFilter[]
  onFilter: (filterId: string, value: string) => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data, error, isLoading } = useQuery({
    queryKey: ['dashboard', dashboardId, 'drill', tile.id, pick.filters, values],
    queryFn: () =>
      http.post<DashboardDrillResult>(`/dashboards/${dashboardId}/drill`, {
        tileId: tile.id,
        filters: values,
        pick: pick.filters,
      }),
    retry: false,
  })
  const cross = crossFilterFor(spec, tile, filters, pick)

  const result = data?.result
  const columns = useMemo<DataGridColumn[]>(
    () =>
      (result?.fields ?? [])
        .filter((field) => !HIDDEN(field.name))
        .map((field) => ({
          key: field.name,
          label: field.label?.[locale] ?? field.label?.ru ?? field.name,
          type: field.type,
          ...(field.format ? { format: field.format } : {}),
        })),
    [result?.fields, locale],
  )
  const rows = useMemo(() => {
    if (!result) return []
    const idIndex = result.fields.findIndex((field) => field.name === '_id')
    return result.rows.map((row, index) => ({
      id: String(idIndex >= 0 ? row[idIndex] : index),
      values: Object.fromEntries(result.fields.map((field, i) => [field.name, row[i]])),
    }))
  }, [result])

  const shown = rows.length
  const total = result?.rowCount ?? shown
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title={pick.label}
        description={
          result
            ? total > shown
              ? t('data.dashboard.drill.countOf', { shown, count: total })
              : t('data.dashboard.drill.count', { count: total })
            : undefined
        }
        width="min(960px, 100vw)"
        footer={
          <>
            {cross ? (
              <Button
                variant="secondary"
                icon={<Filter className="size-4" />}
                onClick={() => {
                  onFilter(cross.filterId, cross.value)
                  onClose()
                }}
              >
                {t('data.dashboard.drill.filterBy', { value: cross.value })}
              </Button>
            ) : null}
            {data ? (
              <Button
                variant="primary"
                icon={<Table2 className="size-4" />}
                onClick={() => {
                  openTab({
                    kind: 'object',
                    objectId: data.datasetId,
                    objectType: 'dataset',
                    title: t('objects.types.dataset'),
                    mode: 'permanent',
                  })
                  onClose()
                }}
              >
                {t('data.dashboard.drill.openDataset')}
              </Button>
            ) : null}
          </>
        }
      >
        {error ? (
          <Callout tone={error instanceof ApiError && error.status < 500 ? 'info' : 'danger'}>
            {error instanceof ApiError ? error.message : t('errors.unknown')}
          </Callout>
        ) : isLoading || !result ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <DataGrid
            aria-label={t('data.dashboard.drill.rows')}
            className="h-[60vh] rounded-md border border-line"
            columns={columns}
            rowCount={rows.length}
            getRow={(index) => rows[index]}
            readOnly
            locale={locale}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
