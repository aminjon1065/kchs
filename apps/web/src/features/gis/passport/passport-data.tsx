import type {
  DatasetRecord,
  FilterNode,
  Locale,
  PassportDataset,
  QueryResult,
} from '@kchs/contracts'
import { formatNumber, formatValue } from '@kchs/fields'
import {
  Button,
  Callout,
  cn,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ObjectIcon,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, Table2 } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { useFieldOptions } from '../../data/field-options.js'
import { datasetQuery } from '../../data/queries.js'

/** Строк таблицы в паспорте: остальное — в датасете или «Исследовании». */
const PREVIEW_ROWS = 100
/** Столбцов таблицы в паспорте: первые поля схемы без геометрии. */
const PREVIEW_COLUMNS = 8
const NUMERIC = new Set(['integer', 'number', 'decimal', 'money', 'percent', 'duration'])
/** Ширина столбца по типу поля, px: значения помещаются в строку без переноса. */
const WIDTHS: Partial<Record<string, number>> = {
  identifier: 200,
  text: 220,
  datetime: 170,
  date: 120,
  territory: 180,
  boolean: 90,
}

type Row = { id: string; values: Record<string, unknown> }

/** Условие «в территории с вложенными» по полю территории датасета. */
export const withinTerritory = (field: string, territoryId: string): FilterNode => ({
  field,
  op: 'within',
  value: territoryId,
})

function RowsTable({ dataset, territoryId }: { dataset: DatasetRecord; territoryId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const options = useFieldOptions(dataset.fields)
  const field = dataset.territoryField as string
  const rows = useQuery({
    queryKey: ['territory', territoryId, 'passport-rows', dataset.id, dataset.currentVersion],
    queryFn: () =>
      http.post<QueryResult>(`/datasets/${dataset.id}/rows/query`, {
        where: withinTerritory(field, territoryId),
        limit: PREVIEW_ROWS,
        count: true,
      }),
    retry: false,
  })
  const shown = dataset.fields.filter((item) => item.type !== 'geometry').slice(0, PREVIEW_COLUMNS)
  const columns: Array<DataTableColumn<Row>> = shown.map((item) => {
    const numeric = NUMERIC.has(item.type)
    return {
      key: item.key,
      header: item.label[locale] ?? item.label.ru,
      width: WIDTHS[item.type] ?? (numeric ? 120 : 180),
      align: numeric ? 'end' : 'start',
      cell: (row) => {
        const text =
          formatValue(
            row.values[item.key],
            {
              type: item.type,
              format: item.format ?? undefined,
              options: options.get(item.key) ?? item.options ?? undefined,
            },
            { locale },
          ) || '—'
        return (
          <span className="block truncate" title={text}>
            {text}
          </span>
        )
      },
    }
  })
  if (rows.isLoading) return <Skeleton className="h-64 w-full" />
  if (rows.error) {
    return (
      <Callout tone="warning">
        {rows.error instanceof ApiError ? rows.error.message : t('errors.unknown')}
      </Callout>
    )
  }
  const result = rows.data as QueryResult
  const index = new Map(result.fields.map((item, position) => [item.name, position]))
  const data: Row[] = result.rows.map((row) => ({
    id: String(row[index.get('_id') ?? 0]),
    values: Object.fromEntries(result.fields.map((item, position) => [item.name, row[position]])),
  }))
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        rows={data}
        getRowId={(row) => row.id}
        columns={columns}
        className="h-80"
        aria-label={t('gis.passport.rowsOf', { name: dataset.name })}
        empty={<EmptyState compact title={t('gis.passport.noRows')} />}
      />
      <p className="text-xs text-fg-muted">
        {t('gis.passport.rowsShown', {
          shown: formatNumber(data.length, {}, { locale }),
          total: formatNumber(result.rowCount ?? data.length, {}, { locale }),
        })}
      </p>
    </div>
  )
}

/**
 * Вкладка «Данные» паспорта: датасеты с полем территории — строки в территории
 * (с вложенными единицами) с политиками смотрящего; «Исследовать» переносит
 * условие территории в конструктор, «Открыть датасет» — вся таблица.
 */
export function PassportData({
  territoryId,
  territoryName,
  datasets,
  selected,
  onSelect,
}: {
  territoryId: string
  territoryName: string
  datasets: readonly PassportDataset[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const current = datasets.find((item) => item.id === selected) ?? datasets[0] ?? null
  const dataset = useQuery({ ...datasetQuery(current?.id ?? ''), enabled: Boolean(current) })

  if (datasets.length === 0) {
    return <EmptyState title={t('gis.passport.noDatasets')} />
  }

  const explore = () => {
    if (!current) return
    const tabId = openTab({
      kind: 'screen',
      screen: 'explore',
      title: t('gis.passport.exploreTitle', { name: current.name, territory: territoryName }),
      params: { datasetId: current.id, territoryId },
      mode: 'permanent',
    })
    setTabState(tabId, {
      explore: {
        datasetId: current.id,
        filter: withinTerritory(current.territoryField, territoryId),
        groups: [],
        measures: [{ agg: 'count' }],
        sort: null,
        limit: null,
      },
      view: 'table',
    })
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
      <ul className="flex flex-col gap-1" aria-label={t('gis.passport.datasets')}>
        {datasets.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={item.id === current?.id}
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-2',
                item.id === current?.id && 'bg-accent-subtle text-accent',
              )}
            >
              <ObjectIcon type="dataset" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.rows !== null ? (
                <span className="tabular shrink-0 text-xs text-fg-muted">
                  {formatNumber(item.rows, {}, { locale })}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {current ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
              {current.name}
            </h3>
            <Button
              size="sm"
              variant="secondary"
              icon={<BarChart3 className="size-3.5" />}
              onClick={explore}
            >
              {t('gis.passport.explore')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Table2 className="size-3.5" />}
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: current.id,
                  objectType: 'dataset',
                  title: current.name,
                  mode: 'permanent',
                })
              }
            >
              {t('gis.passport.openDataset')}
            </Button>
          </div>
          {dataset.data ? (
            <RowsTable dataset={dataset.data} territoryId={territoryId} />
          ) : (
            <Skeleton className="h-64 w-full" />
          )}
        </div>
      ) : null}
    </div>
  )
}
