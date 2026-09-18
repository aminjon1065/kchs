import type { ChartPick } from '@kchs/chart-spec'
import type {
  DashboardFilter,
  DashboardSpec,
  DashboardTile,
  MetricComparison,
  MetricTileOptions,
} from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Button,
  Callout,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  InlineEdit,
  Input,
  ObjectIcon,
  PanelToolbar,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Filter, Pencil, Plus, RefreshCw, Share2, Trash2, Tv, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectListQuery, objectQuery } from '~/shared/api/queries.js'
import { DrillSheet } from './dashboard-drill.js'
import {
  moveTile,
  nextId,
  orderedTiles,
  PERIOD_PRESETS,
  type PeriodPreset,
  packTiles,
  parseValues,
  periodValue,
} from './dashboard-layout.js'
import { TileCard } from './dashboard-tile.js'
import { DashboardTv } from './dashboard-tv.js'
import { METRIC_PERIOD_PRESETS, type MetricPeriodPreset, presetPeriod } from './metric-format.js'
import { dashboardDataQuery, dashboardQuery, dataKeys } from './queries.js'

const AS_METRIC = '__metric'
const COMPARISONS: MetricComparison[] = ['none', 'previous_period', 'previous_year', 'target']

/**
 * Дашборд (03-screens.md §8): фильтры сверху и плитки сеткой; в режиме правки —
 * добавление, размер, порядок, фильтры и их привязка к полям плиток.
 */
export function DashboardView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)
  const [draft, setDraft] = useState<DashboardSpec | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [adding, setAdding] = useState(false)
  const [addingFilter, setAddingFilter] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [tv, setTv] = useState(false)
  const [drill, setDrill] = useState<{ tile: DashboardTile; pick: ChartPick } | null>(null)
  const locale = useAppearance((s) => s.locale)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: dashboard, isLoading } = useQuery(dashboardQuery(objectId))
  const refresh = dashboard?.spec.refreshInterval
  const data = useQuery({
    ...dashboardDataQuery(objectId, values),
    // В TV-режиме данные обновляет он сам
    enabled: Boolean(dashboard) && !tv,
    ...(refresh ? { refetchInterval: refresh * 1000 } : {}),
  })

  const rename = useMutation({
    mutationFn: (name: string) => http.patch(`/dashboards/${objectId}`, { name }),
    onSuccess: (_result, name) => {
      setTabTitle(tabId, name)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: dataKeys.dashboard(objectId) })
    },
  })
  const save = useMutation({
    mutationFn: (spec: DashboardSpec) =>
      http.patch(`/dashboards/${objectId}`, {
        spec: { ...spec, tiles: packTiles(orderedTiles(spec.tiles)) },
      }),
    onSuccess: () => {
      toast.show({ title: t('data.dashboard.saved'), tone: 'success' })
      setDraft(null)
      void client.invalidateQueries({ queryKey: dataKeys.dashboard(objectId) })
      void client.invalidateQueries({ queryKey: ['dashboard', objectId, 'data'] })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
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
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (!dashboard) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  const editing = draft !== null
  const spec = draft ?? dashboard.spec
  const tiles = orderedTiles(spec.tiles)
  const setTiles = (next: DashboardTile[]) =>
    draft && setDraft({ ...draft, tiles: packTiles(next) })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="dashboard" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={dashboard.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
          </>
        }
        right={
          editing ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon={<Filter className="size-3.5" />}
                onClick={() => setAddingFilter(true)}
              >
                {t('data.dashboard.addFilter')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="size-3.5" />}
                onClick={() => setAdding(true)}
              >
                {t('data.dashboard.addTile')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                {t('data.dashboard.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={save.isPending}
                onClick={() => save.mutate(spec)}
              >
                {t('data.dashboard.done')}
              </Button>
            </>
          ) : (
            <>
              {data.dataUpdatedAt ? (
                <span className="hidden text-xs text-fg-muted md:inline">
                  {t('data.dashboard.updated', {
                    time: formatRelativeTime(new Date(data.dataUpdatedAt), { locale }),
                  })}
                </span>
              ) : null}
              <PresenceAvatars objectId={objectId} />
              <Button
                variant="ghost"
                size="sm"
                icon={<Tv className="size-3.5" />}
                disabled={tiles.length === 0}
                onClick={() => setTv(true)}
              >
                {t('data.dashboard.tv.enter')}
              </Button>
              <IconButton
                label={t('data.dashboard.refresh')}
                onClick={() =>
                  void client.invalidateQueries({ queryKey: ['dashboard', objectId, 'data'] })
                }
              >
                <RefreshCw className="size-4" />
              </IconButton>
              {canEdit ? (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Pencil className="size-3.5" />}
                  onClick={() => setDraft(dashboard.spec)}
                >
                  {t('data.dashboard.edit')}
                </Button>
              ) : null}
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
          )
        }
      />

      {spec.filters.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-line bg-surface-2 px-4 py-2">
          {spec.filters.map((filter) => (
            <FilterControl
              key={filter.id}
              filter={filter}
              value={values[filter.id]}
              onChange={(value) => setValues((current) => ({ ...current, [filter.id]: value }))}
              onRemove={
                editing
                  ? () =>
                      setDraft({
                        ...spec,
                        filters: spec.filters.filter((item) => item.id !== filter.id),
                        tiles: spec.tiles.map((tile) => {
                          const { [filter.id]: _removed, ...bindings } = tile.filterBindings
                          return { ...tile, filterBindings: bindings }
                        }),
                      })
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-4">
        {tiles.length === 0 ? (
          <EmptyState
            title={t('data.dashboard.empty')}
            description={canEdit ? t('data.dashboard.emptyHint') : undefined}
          />
        ) : (
          <div className="grid auto-rows-[80px] grid-cols-12 gap-3">
            {tiles.map((tile, index) => (
              <TileCard
                key={tile.id}
                tile={tile}
                data={data.data?.tiles[tile.id]}
                pending={data.isFetching}
                editing={editing}
                filters={spec.filters}
                onChange={(next) =>
                  setTiles(tiles.map((item) => (item.id === tile.id ? next : item)))
                }
                onMove={(delta) => setTiles(moveTile(tiles, index, delta))}
                onRemove={() => setTiles(tiles.filter((item) => item.id !== tile.id))}
                onPick={(pick) => setDrill({ tile, pick })}
              />
            ))}
          </div>
        )}
      </div>

      {drill && !editing ? (
        <DrillSheet
          dashboardId={objectId}
          tile={drill.tile}
          spec={data.data?.tiles[drill.tile.id]?.spec ?? null}
          pick={drill.pick}
          values={values}
          filters={spec.filters}
          onFilter={(filterId, value) => setValues({ ...values, [filterId]: value })}
          onClose={() => setDrill(null)}
        />
      ) : null}
      {adding && draft ? (
        <AddTileDialog
          spaceId={dashboard.spaceId}
          tiles={tiles}
          onClose={() => setAdding(false)}
          onAdd={(tile) => {
            setTiles([...tiles, tile])
            setAdding(false)
          }}
        />
      ) : null}
      {addingFilter && draft ? (
        <AddFilterDialog
          filters={spec.filters}
          onClose={() => setAddingFilter(false)}
          onAdd={(filter) => {
            setDraft({ ...draft, filters: [...draft.filters, filter] })
            setAddingFilter(false)
          }}
        />
      ) : null}
      {tv ? (
        <DashboardTv
          dashboard={dashboard}
          values={values}
          onExit={() => {
            setTv(false)
            void client.invalidateQueries({ queryKey: ['dashboard', objectId, 'data'] })
          }}
        />
      ) : null}
      <ShareDialog
        objectId={objectId}
        title={dashboard.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: dashboard.name })}
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

// ─── Фильтры ─────────────────────────────────────────────────────────────────

function FilterControl({
  filter,
  value,
  onChange,
  onRemove,
}: {
  filter: DashboardFilter
  value: unknown
  onChange: (value: unknown) => void
  onRemove?: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const label = filter.label[locale] ?? filter.label.ru
  const external = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  const [text, setText] = useState(external)
  // Значение, заданное не из поля (перекрёстный фильтр из детализации), — видно в поле
  useEffect(() => setText(external), [external])

  let control: ReactNode
  if (filter.kind === 'territory') {
    control = <TerritorySelect value={value} onChange={onChange} label={label} />
  } else if (filter.kind === 'period') {
    const current =
      PERIOD_PRESETS.find(
        (preset) => JSON.stringify(periodValue(preset)) === JSON.stringify(value ?? null),
      ) ?? 'all'
    control = (
      <Select value={current} onValueChange={(next) => onChange(periodValue(next as PeriodPreset))}>
        <SelectTrigger aria-label={label} className="h-7 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERIOD_PRESETS.map((preset) => (
            <SelectItem key={preset} value={preset}>
              {t(`data.dashboard.periods.${preset}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else {
    const commit = () =>
      onChange(filter.kind === 'select' ? parseValues(text) : text.trim() || null)
    control = (
      <Input
        value={text}
        aria-label={label}
        placeholder={filter.kind === 'select' ? t('data.dashboard.valuesHint') : undefined}
        className="h-7 w-52 text-xs"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-2xs font-medium text-fg-secondary">
        {label}
        {onRemove ? (
          <IconButton label={t('data.dashboard.removeFilter')} size="sm" onClick={onRemove}>
            <X className="size-3" />
          </IconButton>
        ) : null}
      </span>
      {control}
    </div>
  )
}

function AddFilterDialog({
  filters,
  onClose,
  onAdd,
}: {
  filters: DashboardFilter[]
  onClose: () => void
  onAdd: (filter: DashboardFilter) => void
}) {
  const t = useT()
  const [label, setLabel] = useState('')
  const [kind, setKind] = useState<'select' | 'text' | 'period' | 'territory'>('select')
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dashboard.addFilterTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!label.trim()}
              onClick={() =>
                onAdd({
                  id: nextId(
                    'f',
                    filters.map((item) => item.id),
                  ),
                  kind,
                  label: { ru: label.trim() },
                })
              }
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('data.dashboard.filterLabel')}>
            <Input
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              aria-label={t('data.dashboard.filterLabel')}
            />
          </Field>
          <Field label={t('data.dashboard.filterKind')}>
            <SegmentedControl
              aria-label={t('data.dashboard.filterKind')}
              value={kind}
              onValueChange={setKind}
              options={(['select', 'text', 'period', 'territory'] as const).map((value) => ({
                value,
                label: t(`data.dashboard.filterKinds.${value}`),
              }))}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Плитки ──────────────────────────────────────────────────────────────────

type TileKind = 'chart' | 'metric' | 'text'
const ADDABLE: TileKind[] = ['chart', 'metric', 'text']
/** Размер новой плитки: график крупнее, показатель — число в строку по четыре. */
const SIZES: Record<TileKind, { w: number; h: number }> = {
  chart: { w: 6, h: 4 },
  metric: { w: 3, h: 2 },
  text: { w: 6, h: 2 },
}

function AddTileDialog({
  spaceId,
  tiles,
  onClose,
  onAdd,
}: {
  spaceId: string
  tiles: DashboardTile[]
  onClose: () => void
  onAdd: (tile: DashboardTile) => void
}) {
  const t = useT()
  const [kind, setKind] = useState<TileKind>('chart')
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [period, setPeriod] = useState<MetricPeriodPreset | typeof AS_METRIC>(AS_METRIC)
  const [comparison, setComparison] = useState<MetricComparison | typeof AS_METRIC>(AS_METRIC)
  const { data: charts } = useQuery({
    ...objectListQuery({ spaceId, types: 'chart', limit: 100 }),
    enabled: kind === 'chart',
  })
  const { data: metrics } = useQuery({
    ...objectListQuery({ spaceId, types: 'metric', limit: 100 }),
    enabled: kind === 'metric',
  })
  const items = (kind === 'metric' ? metrics?.items : charts?.items) ?? []
  const source = items.find((item) => item.id === sourceId)
  const ready = kind === 'text' ? Boolean(text.trim()) : Boolean(source)
  const bottom = Math.max(0, ...tiles.map((tile) => tile.y + tile.h))

  const metricOptions = (): MetricTileOptions | undefined => {
    const options: MetricTileOptions = {
      ...(period !== AS_METRIC ? { period: presetPeriod(period) } : {}),
      ...(comparison !== AS_METRIC ? { comparison } : {}),
    }
    return Object.keys(options).length > 0 ? options : undefined
  }

  const create = (): DashboardTile => {
    const base = {
      id: nextId(
        't',
        tiles.map((tile) => tile.id),
      ),
      kind,
      filterBindings: {},
      x: 0,
      y: bottom,
      ...SIZES[kind],
    }
    if (kind === 'text') return { ...base, text: text.trim() }
    if (kind === 'metric' && source) {
      const options = metricOptions()
      return {
        ...base,
        metricId: source.id,
        title: source.title,
        ...(options ? { metric: options } : {}),
      }
    }
    return { ...base, chartId: source?.id, title: source?.title ?? null }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('data.dashboard.addTileTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" disabled={!ready} onClick={() => onAdd(create())}>
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <SegmentedControl
            aria-label={t('data.dashboard.addTileTitle')}
            value={kind}
            onValueChange={(next) => {
              setKind(next)
              setSourceId(null)
            }}
            options={ADDABLE.map((value) => ({
              value,
              label: t(`data.dashboard.tileKinds.${value}`),
            }))}
          />
          {kind === 'text' ? (
            <Field label={t('data.dashboard.text')}>
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={t('data.dashboard.text')}
              />
            </Field>
          ) : items.length === 0 ? (
            <Callout tone="info">
              {t(kind === 'metric' ? 'data.dashboard.noMetrics' : 'data.dashboard.noCharts')}
            </Callout>
          ) : (
            <Field
              label={t(
                kind === 'metric' ? 'data.dashboard.pickMetric' : 'data.dashboard.pickChart',
              )}
            >
              <Select value={sourceId ?? undefined} onValueChange={setSourceId}>
                <SelectTrigger
                  aria-label={t(
                    kind === 'metric' ? 'data.dashboard.pickMetric' : 'data.dashboard.pickChart',
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === 'metric' && source ? (
            <>
              <Field label={t('data.dashboard.metricPeriod')}>
                <Select
                  value={period}
                  onValueChange={(next) => setPeriod(next as MetricPeriodPreset | typeof AS_METRIC)}
                >
                  <SelectTrigger aria-label={t('data.dashboard.metricPeriod')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AS_METRIC}>{t('data.dashboard.asMetric')}</SelectItem>
                    {METRIC_PERIOD_PRESETS.map((preset) => (
                      <SelectItem key={preset} value={preset}>
                        {t(`data.metric.periods.${preset}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('data.dashboard.metricComparison')}>
                <Select
                  value={comparison}
                  onValueChange={(next) =>
                    setComparison(next as MetricComparison | typeof AS_METRIC)
                  }
                >
                  <SelectTrigger aria-label={t('data.dashboard.metricComparison')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AS_METRIC}>{t('data.dashboard.asMetric')}</SelectItem>
                    {COMPARISONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`data.metric.comparisons.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
