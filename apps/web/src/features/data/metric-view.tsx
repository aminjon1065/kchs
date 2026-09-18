import {
  ChartSpec,
  METRIC_COMPARISONS,
  type MetricComparison,
  type MetricPeriod,
  type MetricRecord,
  type MetricValue,
  type ObjectSummary,
  type QueryResult,
} from '@kchs/contracts'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Chart,
  EmptyState,
  FilterSummary,
  IconButton,
  InlineEdit,
  KeyValueList,
  NoAccessState,
  NumberTile,
  ObjectIcon,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LayoutDashboard, Pencil, RefreshCw, Share2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, objectLinksQuery, objectQuery } from '~/shared/api/queries.js'
import { AddToDashboardDialog } from './dashboard-dialogs.js'
import { fieldLabel, filterFieldsOf } from './field-types.js'
import { MetricEditor } from './metric-editor.js'
import {
  formatMetricNumber,
  METRIC_PERIOD_PRESETS,
  type MetricPeriodPreset,
  metricTileModel,
  periodPreset,
  periodText,
  presetPeriod,
} from './metric-format.js'
import { dataKeys, datasetQuery, metricQuery, metricValueQuery } from './queries.js'

const CUSTOM = 'custom'
/** Агрегаты, у которых история — столбцы (количество и суммы складываются). */
const ADDITIVE = new Set(['count', 'count_distinct', 'sum'])

/** История показателя как результат запроса — для графика в карточке. */
function historyResult(value: MetricValue): QueryResult {
  return {
    fields: [
      { name: 'period', type: 'date', semantic: 'time', label: null, format: null },
      { name: 'value', type: 'number', semantic: 'measure', label: null, format: value.format },
    ],
    rows: value.series.map((point) => [point.period, point.value]),
    rowCount: value.series.length,
    approx: false,
    truncated: false,
    durationMs: 0,
    cached: false,
  }
}

function historySpec(metric: MetricRecord): ChartSpec {
  return ChartSpec.parse({
    version: 1,
    type: ADDITIVE.has(metric.definition.measure.agg) ? 'bar' : 'line',
    data: { metricId: metric.id },
    encoding: {
      x: { field: 'period', type: 'temporal' },
      y: [
        {
          field: 'value',
          type: 'quantitative',
          label: { ru: metric.name },
          ...(metric.format ? { format: metric.format } : {}),
        },
      ],
    },
    options: { legend: { show: false, position: 'bottom' } },
  })
}

/**
 * Карточка показателя (06-analytics-engine.md §7): значение с выбранными
 * периодом и сравнением, история, разрез, определение и «где используется».
 * Значение считает сервер с политиками смотрящего (ADR-0058).
 */
export function MetricView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [editing, setEditing] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [addingToDashboard, setAddingToDashboard] = useState(false)
  const [period, setPeriod] = useState<MetricPeriod | null | undefined>(undefined)
  const [comparison, setComparison] = useState<MetricComparison | undefined>(undefined)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: me } = useQuery(meQuery())
  const { data: metric, isLoading } = useQuery(metricQuery(objectId))
  const value = useQuery({
    ...metricValueQuery(objectId, {
      ...(period !== undefined ? { period } : {}),
      ...(comparison ? { comparison } : {}),
    }),
    enabled: Boolean(metric),
  })

  const rename = useMutation({
    mutationFn: (name: string) => http.patch(`/metrics/${objectId}`, { name }),
    onSuccess: (_result, name) => {
      setTabTitle(tabId, name)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: dataKeys.metric(objectId) })
    },
  })
  const trash = useMutation({
    mutationFn: () => http.delete(`/objects/${objectId}`),
    onSuccess: () => {
      toast.show({
        title: t('objects.trash.movedTo'),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => void http.post(`/objects/${objectId}/restore`),
        },
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      closeTab(tabId)
    },
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    )
  }
  if (!metric) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  const noAccess =
    value.error instanceof ApiError && (value.error.status === 403 || value.error.status === 404)
  const current = value.data
  const shownPeriod = period === undefined ? metric.definition.period : period
  const preset = periodPreset(shownPeriod)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="metric" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={metric.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            {metric.unit ? <Badge size="sm">{metric.unit}</Badge> : null}
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil className="size-3.5" />}
                onClick={() => setEditing(true)}
              >
                {t('data.metric.edit')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<LayoutDashboard className="size-3.5" />}
              onClick={() => setAddingToDashboard(true)}
            >
              {t('data.dashboard.addToDashboard')}
            </Button>
            <IconButton
              label={t('data.metric.refresh')}
              onClick={() =>
                void client.invalidateQueries({ queryKey: ['metric', objectId, 'value'] })
              }
            >
              <RefreshCw className="size-4" />
            </IconButton>
            <IconButton label={t('common.actions.share')} onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" />
            </IconButton>
            {canManage ? (
              <IconButton
                label={t('common.actions.delete')}
                variant="danger"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            ) : null}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-5">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          {metric.description ? (
            <p className="text-sm text-fg-secondary">{metric.description}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={preset}
              onValueChange={(next) =>
                next !== CUSTOM && setPeriod(presetPeriod(next as MetricPeriodPreset))
              }
            >
              <SelectTrigger aria-label={t('data.metric.period')} className="h-8 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preset === CUSTOM ? (
                  <SelectItem value={CUSTOM}>{periodText(shownPeriod, t, locale)}</SelectItem>
                ) : null}
                {METRIC_PERIOD_PRESETS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`data.metric.periods.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={comparison ?? metric.definition.comparison}
              onValueChange={(next) => setComparison(next as MetricComparison)}
            >
              <SelectTrigger aria-label={t('data.metric.comparison')} className="h-8 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRIC_COMPARISONS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`data.metric.comparisons.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {noAccess ? (
            <Card>
              <NoAccessState />
            </Card>
          ) : value.error ? (
            <Callout tone="danger">
              {value.error instanceof ApiError ? value.error.message : t('data.metric.failed')}
            </Callout>
          ) : current ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
              <NumberTile
                size="lg"
                model={metricTileModel(current, t, locale, periodText(current.period, t, locale))}
              />
              <Card title={t('data.metric.history')}>
                {current.series.length > 1 ? (
                  <Chart
                    spec={historySpec(metric)}
                    result={historyResult(current)}
                    height={220}
                    pending={value.isFetching}
                    {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
                  />
                ) : (
                  <p className="text-sm text-fg-muted">{t('data.metric.noHistory')}</p>
                )}
              </Card>
            </div>
          ) : (
            <Skeleton className="h-48 w-full" />
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {metric.definition.dimensions.length > 0 && !noAccess ? (
              <BreakdownCard
                metric={metric}
                period={shownPeriod}
                comparison={comparison ?? metric.definition.comparison}
              />
            ) : null}
            <DefinitionCard metric={metric} />
            <UsageCard metricId={objectId} />
          </div>
        </div>
      </div>

      {editing ? (
        <MetricEditor spaceId={metric.spaceId} metric={metric} onClose={() => setEditing(false)} />
      ) : null}
      {addingToDashboard ? (
        <AddToDashboardDialog
          source={{ kind: 'metric', id: metric.id, name: metric.name, spaceId: metric.spaceId }}
          onClose={() => setAddingToDashboard(false)}
        />
      ) : null}
      <ShareDialog
        objectId={objectId}
        title={metric.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: metric.name })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          trash.mutate()
          setDeleteOpen(false)
        }}
      />
    </div>
  )
}

/** Разрез значения по одному из допустимых полей: верхние значения и база сравнения. */
function BreakdownCard({
  metric,
  period,
  comparison,
}: {
  metric: MetricRecord
  period: MetricPeriod | null
  comparison: MetricComparison
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const [dimension, setDimension] = useState(metric.definition.dimensions[0] ?? '')
  const { data: dataset } = useQuery(datasetQuery(metric.datasetId))
  const { data, isLoading } = useQuery(
    metricValueQuery(metric.id, { period, comparison, dimensions: [dimension], series: false }),
  )
  const label = (key: string) => {
    const field = dataset?.fields.find((item) => item.key === key)
    return field ? fieldLabel(field, locale) : key
  }
  const format = (value: number | null) =>
    value === null ? t('data.metric.none') : formatMetricNumber(value, metric.format, locale)
  const withBase = comparison === 'previous_period' || comparison === 'previous_year'

  return (
    <Card
      title={t('data.metric.breakdown')}
      action={
        <Select value={dimension} onValueChange={setDimension}>
          <SelectTrigger aria-label={t('data.metric.breakdownBy')} className="h-7 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {metric.definition.dimensions.map((key) => (
              <SelectItem key={key} value={key}>
                {label(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      padded={false}
    >
      {isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-surface-2 text-xs text-fg-secondary">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {label(dimension)}
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  {t('data.metric.value')}
                </th>
                {withBase ? (
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    {t(`data.metric.compareLabels.${comparison}`)}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {(data?.breakdown ?? []).map((row) => {
                const key = String(row.values[dimension] ?? '')
                return (
                  <tr key={key} className="border-t border-line">
                    <td className="px-4 py-1.5 text-fg">{key || t('data.metric.empty')}</td>
                    <td className="tabular px-4 py-1.5 text-right text-fg">{format(row.value)}</td>
                    {withBase ? (
                      <td className="tabular px-4 py-1.5 text-right text-fg-secondary">
                        {format(row.base)}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/** Определение показателя: датасет, мера, условия, поле времени, пороги и цели. */
function DefinitionCard({ metric }: { metric: MetricRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data: dataset } = useQuery(datasetQuery(metric.datasetId))
  const { definition } = metric
  const fields = dataset?.fields ?? []
  const label = (key: string | null | undefined) => {
    if (!key) return null
    const field = fields.find((item) => item.key === key)
    return field ? fieldLabel(field, locale) : key
  }
  const measure =
    definition.measure.agg === 'expr'
      ? definition.measure.expr
      : t('data.metric.measureOf', {
          agg: t(`data.metric.aggregates.${definition.measure.agg}`),
          field: label(definition.measure.field) ?? t('data.metric.rows'),
        })
  const format = (value: number) => formatMetricNumber(value, metric.format, locale)

  return (
    <Card title={t('data.metric.definition')}>
      <KeyValueList
        items={[
          {
            key: 'dataset',
            label: t('data.metric.dataset'),
            value: dataset ? (
              <button
                type="button"
                className="text-left text-accent hover:underline"
                onClick={() =>
                  openTab({
                    kind: 'object',
                    objectId: dataset.id,
                    objectType: 'dataset',
                    title: dataset.name,
                    mode: 'preview',
                  })
                }
              >
                {dataset.name}
              </button>
            ) : (
              t('data.metric.hiddenObject')
            ),
          },
          { key: 'measure', label: t('data.metric.measure'), value: measure },
          ...(definition.filter
            ? [
                {
                  key: 'filter',
                  label: t('data.metric.filter'),
                  value: (
                    <FilterSummary
                      fields={filterFieldsOf(fields, locale)}
                      value={definition.filter}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'time',
            label: t('data.metric.timeField'),
            value: label(definition.timeField ?? dataset?.timeField) ?? t('data.metric.noTime'),
          },
          ...(definition.dimensions.length > 0
            ? [
                {
                  key: 'dimensions',
                  label: t('data.metric.dimensions'),
                  value: definition.dimensions.map((key) => label(key)).join(', '),
                },
              ]
            : []),
          {
            key: 'direction',
            label: t('data.metric.direction'),
            value: t(`data.metric.directions.${metric.direction}`),
          },
          ...(metric.targets.length > 0
            ? [
                {
                  key: 'targets',
                  label: t('data.metric.targets'),
                  value: metric.targets
                    .map((target) =>
                      target.unit
                        ? t('data.metric.targetPer', {
                            value: format(target.value),
                            unit: t(`data.metric.targetUnits.${target.unit}`),
                          })
                        : format(target.value),
                    )
                    .join('; '),
                },
              ]
            : []),
          ...(metric.thresholds.length > 0
            ? [
                {
                  key: 'thresholds',
                  label: t('data.metric.thresholds'),
                  value: (
                    <span className="flex flex-wrap gap-1">
                      {[...metric.thresholds]
                        .sort((a, b) => a.value - b.value)
                        .map((threshold) => (
                          <Badge
                            key={`${threshold.value}-${threshold.status}`}
                            size="sm"
                            tone={threshold.status}
                          >
                            {t('data.metric.thresholdFrom', {
                              value: format(threshold.value),
                              status: t(`data.metric.statuses.${threshold.status}`),
                            })}
                          </Badge>
                        ))}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  )
}

/** Где используется: дашборды и графики с этим показателем; недоступные — без названия. */
function UsageCard({ metricId }: { metricId: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(objectLinksQuery(metricId))
  const usedBy: ObjectSummary[] = data?.usedBy ?? []
  return (
    <Card title={t('data.metric.usedIn')}>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : usedBy.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('data.metric.notUsed')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {usedBy.map((item) => (
            <li key={item.id}>
              {item.accessible ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-xs px-1.5 py-1 text-left text-sm text-fg hover:bg-surface-3"
                  onClick={() =>
                    openTab({
                      kind: 'object',
                      objectId: item.id,
                      objectType: item.type,
                      title: item.title,
                      mode: 'preview',
                    })
                  }
                >
                  <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                  <span className="min-w-0 truncate">{item.title}</span>
                </button>
              ) : (
                <span className="flex items-center gap-2 px-1.5 py-1 text-sm text-fg-muted">
                  <ObjectIcon type={item.type} className="size-4 shrink-0" />
                  {t('data.metric.hiddenObject')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
