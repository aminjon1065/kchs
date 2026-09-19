import {
  ChartSpec,
  type ControlBucket,
  type ControlCounts,
  type ControlListItem,
  type ControlQuery,
  type ControlReport,
  type ControlSource,
  type OrgUnit,
  type QueryResult,
} from '@kchs/contracts'
import { formatDate, formatPercent, formatRelativeTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Chart,
  Checkbox,
  cn,
  DataTable,
  type DataTableColumn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  NumberTile,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Download, RefreshCw } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { metricTileModel } from '~/features/data/metric-format.js'
import { metricValueQuery } from '~/features/data/queries.js'
import { orgUnitsQuery } from '~/shared/api/queries.js'
import { controlListQuery, controlQuery, queryOf, taskKeys } from './queries.js'
import { type PickedUser, UserPicker } from './user-picker.js'

type Translate = ReturnType<typeof useT>

const PERIODS = ['all', 'week', 'month', 'prevMonth', 'quarter', 'year', 'custom'] as const
type Period = (typeof PERIODS)[number]

const SOURCES: ControlSource[] = ['any', 'resolution', 'object', 'dataset_row', 'none']
const ALL_UNITS = '__all'

/** Столбцы матрицы: состояния, «продлено» и итог (ADR-0082). */
const COLUMNS: Array<{ bucket: ControlBucket; count: keyof ControlCounts }> = [
  { bucket: 'on_track', count: 'onTrack' },
  { bucket: 'due_today', count: 'dueToday' },
  { bucket: 'overdue', count: 'overdue' },
  { bucket: 'extended', count: 'extended' },
  { bucket: 'done_on_time', count: 'doneOnTime' },
  { bucket: 'done_late', count: 'doneLate' },
  { bucket: 'total', count: 'total' },
]

/** Тон числа ячейки: просрочка и опоздание заметны сразу. */
const BUCKET_TONE: Partial<Record<ControlBucket, string>> = {
  overdue: 'text-danger',
  done_late: 'text-warning',
  due_today: 'text-accent',
}

const STATE_BADGE: Record<
  ControlListItem['state'],
  'neutral' | 'accent' | 'danger' | 'success' | 'warning'
> = {
  on_track: 'neutral',
  due_today: 'accent',
  overdue: 'danger',
  done_on_time: 'success',
  done_late: 'warning',
}

/** Потоковая выгрузка с сервера: GET с cookie-сессией, файл отдаёт `content-disposition`. */
function download(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = ''
  document.body.appendChild(link)
  link.click()
  link.remove()
}

const pad = (value: number) => String(value).padStart(2, '0')
const iso = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** Даты периода по часам смотрящего: включительно, как фильтр срока на сервере. */
function periodRange(
  period: Period,
  custom: { from: string; to: string },
): { from?: string; to?: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  switch (period) {
    case 'week': {
      const monday = new Date(year, month, now.getDate() - ((now.getDay() + 6) % 7))
      const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
      return { from: iso(monday), to: iso(sunday) }
    }
    case 'month':
      return { from: iso(new Date(year, month, 1)), to: iso(new Date(year, month + 1, 0)) }
    case 'prevMonth':
      return { from: iso(new Date(year, month - 1, 1)), to: iso(new Date(year, month, 0)) }
    case 'quarter': {
      const first = Math.floor(month / 3) * 3
      return { from: iso(new Date(year, first, 1)), to: iso(new Date(year, first + 3, 0)) }
    }
    case 'year':
      return { from: iso(new Date(year, 0, 1)), to: iso(new Date(year, 11, 31)) }
    case 'custom':
      return {
        ...(custom.from ? { from: custom.from } : {}),
        ...(custom.to ? { to: custom.to } : {}),
      }
    default:
      return {}
  }
}

/** Подразделения деревом: порядок обхода и глубина для отступа в списке. */
function unitOptions(
  units: OrgUnit[],
  locale: string,
): Array<{ id: string; name: string; depth: number }> {
  const children = new Map<string | null, OrgUnit[]>()
  for (const unit of units) {
    const list = children.get(unit.parentId) ?? []
    list.push(unit)
    children.set(unit.parentId, list)
  }
  const label = (unit: OrgUnit) =>
    (unit.name as Record<string, string | undefined>)[locale] ?? unit.name.ru
  const result: Array<{ id: string; name: string; depth: number }> = []
  const walk = (parentId: string | null, depth: number) => {
    const list = [...(children.get(parentId) ?? [])].sort(
      (a, b) => a.sort - b.sort || label(a).localeCompare(label(b), locale),
    )
    for (const unit of list) {
      result.push({ id: unit.id, name: label(unit), depth })
      if (depth < 6) walk(unit.id, depth + 1)
    }
  }
  walk(null, 0)
  return result
}

const INDENT = ['pl-0', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-14', 'pl-16']

export interface ControlScreenState {
  period?: Period
  from?: string
  to?: string
  unitId?: string
  source?: ControlSource
  parts?: boolean
}

/**
 * Экран «Контроль» (03-screens.md §12, 08-documents.md §7, ADR-0082):
 * матрица «подразделения × состояния» с числами-ссылками, фильтры, список
 * поручений ячейки (по умолчанию — просроченные), динамика по неделям срока,
 * показатели контроля и выгрузка. Всё считает сервер по системному датасету
 * «Поручения» с правами смотрящего.
 */
export function ControlScreen({
  tabId,
  savedState,
}: {
  tabId?: string
  savedState?: ControlScreenState
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const fromId = useId()
  const toId = useId()
  const [period, setPeriod] = useState<Period>(savedState?.period ?? 'all')
  const [custom, setCustom] = useState({ from: savedState?.from ?? '', to: savedState?.to ?? '' })
  const [unitId, setUnitId] = useState<string>(savedState?.unitId ?? ALL_UNITS)
  const [source, setSource] = useState<ControlSource>(savedState?.source ?? 'any')
  const [parts, setParts] = useState(savedState?.parts ?? false)
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [controller, setController] = useState<PickedUser | null>(null)
  const [drill, setDrill] = useState<{ row: string | null; bucket: ControlBucket }>({
    row: null,
    bucket: 'overdue',
  })

  useEffect(() => {
    if (tabId) {
      setTabState(tabId, {
        period,
        from: custom.from,
        to: custom.to,
        unitId,
        source,
        parts,
      })
    }
  }, [tabId, period, custom, unitId, source, parts, setTabState])

  const query: Partial<ControlQuery> = {
    ...periodRange(period, custom),
    ...(unitId !== ALL_UNITS ? { unitId } : {}),
    ...(assignee ? { assigneeId: assignee.id } : {}),
    ...(controller ? { controllerId: controller.id } : {}),
    source,
    parts,
  }
  const report = useQuery(controlQuery(query))
  const list = useQuery(
    controlListQuery({
      ...query,
      bucket: drill.bucket,
      ...(drill.row ? { row: drill.row } : {}),
      limit: 200,
    }),
  )
  const { data: units = [] } = useQuery(orgUnitsQuery())
  const options = useMemo(() => unitOptions(units, locale), [units, locale])

  const open = (item: ControlListItem) =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'task',
      title: item.title,
      mode: 'permanent',
    })
  const select = (row: string | null, bucket: ControlBucket) => setDrill({ row, bucket })
  const exportUrl = (format: 'csv' | 'xlsx', view: 'matrix' | 'list') => {
    const params = new URLSearchParams(
      Object.entries(
        queryOf({
          ...query,
          format,
          view,
          // Список — тот, что на экране: состояние и строка матрицы
          ...(view === 'list' ? { bucket: drill.bucket, row: drill.row ?? undefined } : {}),
        }),
      ).map(([key, value]) => [key, String(value)]),
    )
    return `/api/v1/tasks/control/export?${params.toString()}`
  }

  const data = report.data
  const rowName = (row: string | null) =>
    row === null
      ? t('tasks.control.listAll')
      : row === 'none'
        ? t('tasks.control.noUnit')
        : (data?.rows.find((item) => item.unitId === row)?.unitName ?? '')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ClipboardCheck className="size-4 text-fg-muted" aria-hidden />
            <h1 className="text-sm font-semibold text-fg">{t('tasks.control.title')}</h1>
            {data ? (
              <span className="text-xs text-fg-muted">
                {t('tasks.control.updated', {
                  time: formatRelativeTime(data.generatedAt, { locale }),
                })}
              </span>
            ) : null}
          </>
        }
        right={
          <>
            <IconButton
              label={t('tasks.control.refresh')}
              onClick={() => void client.invalidateQueries({ queryKey: taskKeys.all })}
            >
              <RefreshCw className="size-4" />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" icon={<Download className="size-3.5" />}>
                  {t('tasks.control.export')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(
                  [
                    ['xlsx', 'matrix', 'exportMatrixXlsx'],
                    ['csv', 'matrix', 'exportMatrixCsv'],
                    ['xlsx', 'list', 'exportListXlsx'],
                    ['csv', 'list', 'exportListCsv'],
                  ] as const
                ).map(([format, view, label]) => (
                  <DropdownMenuItem key={label} onSelect={() => download(exportUrl(format, view))}>
                    {t(`tasks.control.${label}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <fieldset
        aria-label={t('tasks.control.filtersLabel')}
        className="m-0 flex min-w-0 shrink-0 flex-wrap items-end gap-3 border-0 border-b border-line bg-surface px-3 py-2.5"
      >
        <Field label={t('tasks.control.filters.unit')}>
          <Select
            value={unitId}
            onValueChange={(next) => {
              setUnitId(next)
              setDrill((current) => ({ ...current, row: null }))
            }}
          >
            <SelectTrigger aria-label={t('tasks.control.filters.unit')} className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_UNITS}>{t('tasks.control.filters.allUnits')}</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span className={INDENT[option.depth] ?? 'pl-16'}>{option.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('tasks.control.filters.period')}>
          <Select value={period} onValueChange={(next) => setPeriod(next as Period)}>
            <SelectTrigger aria-label={t('tasks.control.filters.period')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`tasks.control.periods.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {period === 'custom' ? (
          <>
            <Field label={t('tasks.control.from')} htmlFor={fromId}>
              <Input
                id={fromId}
                type="date"
                value={custom.from}
                onChange={(event) =>
                  setCustom((current) => ({ ...current, from: event.target.value }))
                }
              />
            </Field>
            <Field label={t('tasks.control.to')} htmlFor={toId}>
              <Input
                id={toId}
                type="date"
                value={custom.to}
                onChange={(event) =>
                  setCustom((current) => ({ ...current, to: event.target.value }))
                }
              />
            </Field>
          </>
        ) : null}
        <Field label={t('tasks.control.filters.source')}>
          <Select value={source} onValueChange={(next) => setSource(next as ControlSource)}>
            <SelectTrigger aria-label={t('tasks.control.filters.source')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`tasks.control.sources.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="w-60">
          <Field label={t('tasks.control.filters.assignee')}>
            <UserPicker
              value={assignee}
              onChange={setAssignee}
              label={t('tasks.control.filters.assignee')}
            />
          </Field>
        </div>
        <div className="w-60">
          <Field label={t('tasks.control.filters.controller')}>
            <UserPicker
              value={controller}
              onChange={setController}
              label={t('tasks.control.filters.controller')}
            />
          </Field>
        </div>
        <Checkbox
          checked={parts}
          onCheckedChange={(checked) => setParts(checked === true)}
          label={t('tasks.control.filters.parts')}
        />
      </fieldset>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-4">
          {report.isLoading || !data ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <>
              <Totals
                data={data}
                t={t}
                locale={locale}
                onSelect={(bucket) => select(null, bucket)}
              />
              <ControlMetrics report={data} />
              <Matrix data={data} t={t} drill={drill} onSelect={select} />
            </>
          )}
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card
              title={t('tasks.control.listTitle', {
                bucket: t(`tasks.control.buckets.${drill.bucket}`),
                unit: rowName(drill.row),
              })}
              action={
                list.data ? (
                  <span className="tabular text-xs text-fg-muted">
                    {t('tasks.control.listCount', { count: list.data.total })}
                  </span>
                ) : null
              }
              padded={false}
            >
              <ControlList items={list.data?.items ?? []} loading={list.isLoading} onOpen={open} />
            </Card>
            <Card title={t('tasks.control.dynamics')}>
              {data ? <Dynamics data={data} t={t} /> : <Skeleton className="h-64 w-full" />}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function Totals({
  data,
  t,
  locale,
  onSelect,
}: {
  data: ControlReport
  t: Translate
  locale: string
  onSelect: (bucket: ControlBucket) => void
}) {
  const totals = data.totals
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
      <StatTile
        label={t('tasks.control.total')}
        value={totals.total}
        onClick={() => onSelect('total')}
      />
      {COLUMNS.filter((column) => column.bucket !== 'total').map((column) => (
        <StatTile
          key={column.bucket}
          label={t(`tasks.control.buckets.${column.bucket}`)}
          value={totals[column.count]}
          onClick={() => onSelect(column.bucket)}
        />
      ))}
      <StatTile
        label={t('tasks.control.onTimeRate')}
        value={
          data.onTimeRate === null
            ? '—'
            : formatPercent(data.onTimeRate, { precision: 0 }, { locale: locale as 'ru' })
        }
      />
    </div>
  )
}

/** Показатели контроля — обычные показатели над системным датасетом «Поручения». */
function ControlMetrics({ report }: { report: ControlReport }) {
  if (report.metrics.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {report.metrics.map((metric) => (
        <MetricTile key={metric.id} metricId={metric.id} />
      ))}
    </div>
  )
}

function MetricTile({ metricId }: { metricId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data: value } = useQuery(metricValueQuery(metricId, {}))
  if (!value) return <Skeleton className="h-28 w-full" />
  return (
    <NumberTile
      model={metricTileModel(value, t, locale)}
      onClick={() =>
        openTab({
          kind: 'object',
          objectId: metricId,
          objectType: 'metric',
          title: value.name,
          mode: 'permanent',
        })
      }
    />
  )
}

/** Матрица «подразделения × состояния»: число — ссылка на список поручений ячейки. */
function Matrix({
  data,
  t,
  drill,
  onSelect,
}: {
  data: ControlReport
  t: Translate
  drill: { row: string | null; bucket: ControlBucket }
  onSelect: (row: string | null, bucket: ControlBucket) => void
}) {
  if (data.rows.length === 0) {
    return (
      <Card>
        <EmptyState
          compact
          icon={<ClipboardCheck />}
          title={t('tasks.control.empty')}
          description={t('tasks.control.emptyHint')}
        />
      </Card>
    )
  }
  const cell = (
    row: string | null,
    unit: string,
    bucket: ControlBucket,
    value: number,
    total = false,
  ) => {
    const active = drill.row === row && drill.bucket === bucket
    return (
      <td key={bucket} className="px-2 py-1 text-right">
        {value > 0 ? (
          <button
            type="button"
            aria-pressed={active}
            // Число само по себе ничего не говорит: в имени — состояние и подразделение
            aria-label={t('tasks.control.cellLabel', {
              bucket: t(`tasks.control.buckets.${bucket}`),
              unit,
              count: value,
            })}
            onClick={() => onSelect(row, bucket)}
            className={cn(
              'tabular rounded-xs px-1.5 py-0.5 text-sm underline-offset-2 hover:underline',
              total ? 'font-semibold' : '',
              BUCKET_TONE[bucket] ?? 'text-fg',
              active && 'bg-accent-subtle',
            )}
          >
            {value}
          </button>
        ) : (
          <span className="tabular px-1.5 text-sm text-fg-muted">0</span>
        )}
      </td>
    )
  }
  return (
    <Card title={t('tasks.control.matrix')} padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label={t('tasks.control.matrix')}>
          <thead>
            <tr className="border-b border-line bg-surface-2 text-xs text-fg-muted">
              <th scope="col" className="px-3 py-2 text-left font-medium">
                {t('tasks.control.unit')}
              </th>
              {COLUMNS.map((column) => (
                <th key={column.bucket} scope="col" className="px-2 py-2 text-right font-medium">
                  {t(`tasks.control.buckets.${column.bucket}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const key = row.unitId ?? 'none'
              return (
                <tr key={key} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    <span className="block text-fg">
                      {row.unitName ?? t('tasks.control.noUnit')}
                    </span>
                    {row.unitPath.length > 0 ? (
                      <span className="block text-2xs text-fg-muted">
                        {row.unitPath.join(' › ')}
                      </span>
                    ) : null}
                  </th>
                  {COLUMNS.map((column) =>
                    cell(
                      key,
                      row.unitName ?? t('tasks.control.noUnit'),
                      column.bucket,
                      row.counts[column.count],
                      column.bucket === 'total',
                    ),
                  )}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface-2">
              <th scope="row" className="px-3 py-2 text-left font-semibold text-fg">
                {t('tasks.control.totals')}
              </th>
              {COLUMNS.map((column) =>
                cell(
                  null,
                  t('tasks.control.listAll'),
                  column.bucket,
                  data.totals[column.count],
                  true,
                ),
              )}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
}

function ControlList({
  items,
  loading,
  onOpen,
}: {
  items: ControlListItem[]
  loading: boolean
  onOpen: (item: ControlListItem) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const columns: Array<DataTableColumn<ControlListItem>> = [
    {
      key: 'title',
      header: t('tasks.fields.title'),
      minWidth: 240,
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-fg-muted">{item.key}</span>
          <span className="truncate">{item.title}</span>
          {item.isPart ? (
            <Badge tone="outline" size="sm">
              {t('tasks.control.isPart')}
            </Badge>
          ) : null}
          {item.extensions > 0 ? (
            <Badge tone="warning" size="sm">
              {t('tasks.extended')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('tasks.control.state'),
      width: 150,
      cell: (item) => (
        <Badge tone={STATE_BADGE[item.state]} size="sm">
          {t(`tasks.control.buckets.${item.state}`)}
        </Badge>
      ),
    },
    {
      key: 'assignee',
      header: t('tasks.fields.assignee'),
      width: 200,
      cell: (item) =>
        item.assignee ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Avatar name={item.assignee.displayName} src={item.assignee.avatarUrl} size="xs" />
            <span className="min-w-0">
              <span className="block truncate">{item.assignee.displayName}</span>
              {item.unitName ? (
                <span className="block truncate text-2xs text-fg-muted">{item.unitName}</span>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      key: 'due',
      header: t('tasks.fields.due'),
      width: 110,
      cell: (item) =>
        item.dueAt ? (
          <span className={cn('tabular', item.state === 'overdue' && 'text-danger')}>
            {formatDate(item.dueAt, { locale })}
          </span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
    {
      key: 'late',
      header: t('tasks.control.daysLate'),
      width: 110,
      align: 'end',
      cell: (item) =>
        item.daysLate ? (
          <span className="tabular text-danger">{item.daysLate}</span>
        ) : (
          <span className="text-fg-muted">—</span>
        ),
    },
  ]
  if (!loading && items.length === 0) {
    return <EmptyState compact title={t('tasks.control.listEmpty')} />
  }
  return (
    <div className="h-96">
      <DataTable
        aria-label={t('tasks.control.list')}
        rows={items}
        getRowId={(item) => item.id}
        columns={columns}
        loading={loading}
        onRowOpen={onOpen}
        onRowClick={onOpen}
      />
    </div>
  )
}

/** Ряды динамики: состояние контроля и цвет столбца. */
const DYNAMICS_SERIES = [
  ['done_on_time', 'success'],
  ['done_late', 'warning'],
  ['overdue', 'danger'],
  ['on_track', 'neutral'],
] as const

/**
 * Спецификация графика динамики. Данные приходят готовыми в отчёте контроля,
 * источник — системный датасет «Поручения» (для подписи и выгрузки графика).
 */
function dynamicsSpec(t: Translate): ChartSpec {
  return ChartSpec.parse({
    version: 1,
    type: 'bar',
    data: { query: { version: 1, source: { kind: 'system', name: 'instructions' } } },
    encoding: {
      x: { field: 'week', type: 'temporal', label: { ru: t('tasks.control.week') } },
      y: DYNAMICS_SERIES.map(([field, color]) => ({
        field,
        type: 'quantitative',
        color,
        label: { ru: t(`tasks.control.buckets.${field}`) },
      })),
    },
    options: { stacked: true, legend: { show: true, position: 'bottom' } },
  })
}

/** Динамика по неделям срока: исполнено в срок, с опозданием, просрочено, в работе. */
function Dynamics({ data, t }: { data: ControlReport; t: Translate }) {
  const spec = useMemo(() => dynamicsSpec(t), [t])
  const result: QueryResult = {
    fields: [
      { name: 'week', type: 'date', semantic: 'time', label: null, format: null },
      { name: 'done_on_time', type: 'integer', semantic: 'measure', label: null, format: null },
      { name: 'done_late', type: 'integer', semantic: 'measure', label: null, format: null },
      { name: 'overdue', type: 'integer', semantic: 'measure', label: null, format: null },
      { name: 'on_track', type: 'integer', semantic: 'measure', label: null, format: null },
    ],
    rows: data.weeks.map((week) => [
      week.week,
      week.doneOnTime,
      week.doneLate,
      week.overdue,
      week.onTrack,
    ]),
    rowCount: data.weeks.length,
    approx: false,
    truncated: false,
    durationMs: 0,
    cached: false,
  }
  return <Chart spec={spec} result={result} height={280} />
}
