import type {
  DashboardFilter,
  DashboardSpec,
  DashboardTile,
  DashboardTileData,
  DatasetField,
} from '@kchs/contracts'
import {
  AlertDialog,
  Button,
  Callout,
  Card,
  Chart,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  InlineEdit,
  Input,
  NoAccessState,
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
import {
  ArrowDown,
  ArrowUp,
  Filter,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, objectListQuery, objectQuery } from '~/shared/api/queries.js'
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
import {
  chartQuery,
  dashboardDataQuery,
  dashboardQuery,
  dataKeys,
  datasetQuery,
} from './queries.js'

/** Высота строки сетки дашборда, px (класс auto-rows-[80px]). */
const ROW = 80
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
const ROW_SPAN = [
  '',
  'row-span-1',
  'row-span-2',
  'row-span-3',
  'row-span-4',
  'row-span-5',
  'row-span-6',
  'row-span-7',
  'row-span-8',
]
const WIDTHS = [3, 4, 6, 8, 12]
const HEIGHTS = [2, 3, 4, 5, 6, 8]
const NONE = '__none'

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

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: dashboard, isLoading } = useQuery(dashboardQuery(objectId))
  const data = useQuery({ ...dashboardDataQuery(objectId, values), enabled: Boolean(dashboard) })

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
              <PresenceAvatars objectId={objectId} />
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
              />
            ))}
          </div>
        )}
      </div>

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
  const [text, setText] = useState(Array.isArray(value) ? value.join(', ') : String(value ?? ''))

  let control: ReactNode
  if (filter.kind === 'period') {
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
  const [kind, setKind] = useState<'select' | 'text' | 'period'>('select')
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
              options={(['select', 'text', 'period'] as const).map((value) => ({
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

function TileCard({
  tile,
  data,
  pending,
  editing,
  filters,
  onChange,
  onMove,
  onRemove,
}: {
  tile: DashboardTile
  data: DashboardTileData | undefined
  pending: boolean
  editing: boolean
  filters: DashboardFilter[]
  onChange: (tile: DashboardTile) => void
  onMove: (delta: number) => void
  onRemove: () => void
}) {
  const t = useT()
  const { data: me } = useQuery(meQuery())
  const [bindings, setBindings] = useState(false)
  const height = Math.min(tile.h, 8)

  let body: ReactNode
  if (tile.kind === 'text' || tile.kind === 'heading') {
    body = (
      <div className="h-full overflow-auto whitespace-pre-wrap text-sm text-fg">{tile.text}</div>
    )
  } else if (data?.error === 'no_access') {
    body = <NoAccessState />
  } else if (data?.error) {
    body = <Callout tone="danger">{t('data.dashboard.failed')}</Callout>
  } else if (data?.spec && data.result) {
    body = (
      <Chart
        spec={data.spec}
        result={data.result}
        height={height * ROW - 64}
        pending={pending}
        {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
      />
    )
  } else {
    body = <Skeleton className="h-full w-full" />
  }

  return (
    <Card
      className={cn(COL_SPAN[tile.w] ?? 'col-span-6', ROW_SPAN[height], 'min-w-0 overflow-hidden')}
      title={tile.title ?? t(`data.dashboard.tileKinds.${tile.kind === 'text' ? 'text' : 'chart'}`)}
      action={
        editing ? (
          <span className="flex items-center gap-1">
            <Select
              value={String(tile.w)}
              onValueChange={(w) => onChange({ ...tile, w: Number(w) })}
            >
              <SelectTrigger aria-label={t('data.dashboard.width')} className="h-6 w-20 text-2xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WIDTHS.map((w) => (
                  <SelectItem key={w} value={String(w)}>
                    {w}/12
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(tile.h)}
              onValueChange={(h) => onChange({ ...tile, h: Number(h) })}
            >
              <SelectTrigger aria-label={t('data.dashboard.height')} className="h-6 w-14 text-2xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HEIGHTS.map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tile.kind === 'chart' && filters.length > 0 ? (
              <IconButton
                label={t('data.dashboard.tileFilters')}
                size="sm"
                onClick={() => setBindings(true)}
              >
                <SlidersHorizontal className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton label={t('data.dashboard.moveUp')} size="sm" onClick={() => onMove(-1)}>
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label={t('data.dashboard.moveDown')} size="sm" onClick={() => onMove(1)}>
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('data.dashboard.removeTile')}
              size="sm"
              variant="danger"
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </span>
        ) : null
      }
    >
      <div className="h-full min-h-0">{body}</div>
      {bindings ? (
        <BindingsDialog
          tile={tile}
          filters={filters}
          onClose={() => setBindings(false)}
          onSave={(filterBindings) => {
            onChange({ ...tile, filterBindings })
            setBindings(false)
          }}
        />
      ) : null}
    </Card>
  )
}

/** Поля источника плитки: датасет сохранённого или встроенного графика. */
function useTileFields(tile: DashboardTile): DatasetField[] {
  const chart = useQuery({ ...chartQuery(tile.chartId ?? ''), enabled: Boolean(tile.chartId) })
  const spec = tile.spec ?? chart.data?.spec
  const source = spec && 'query' in spec.data ? spec.data.query.source : null
  const datasetId = source?.kind === 'dataset' ? source.id : ''
  const dataset = useQuery({ ...datasetQuery(datasetId), enabled: Boolean(datasetId) })
  return dataset.data?.fields ?? []
}

function BindingsDialog({
  tile,
  filters,
  onClose,
  onSave,
}: {
  tile: DashboardTile
  filters: DashboardFilter[]
  onClose: () => void
  onSave: (bindings: Record<string, string>) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const fields = useTileFields(tile)
  const [bindings, setBindings] = useState<Record<string, string>>(tile.filterBindings)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={tile.title ?? t('data.dashboard.tileKinds.chart')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" onClick={() => onSave(bindings)}>
              {t('data.dashboard.done')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {filters.map((filter) => {
            const label = t('data.dashboard.bindings', {
              filter: filter.label[locale] ?? filter.label.ru,
            })
            return (
              <Field key={filter.id} label={label}>
                <Select
                  value={bindings[filter.id] ?? NONE}
                  onValueChange={(field) =>
                    setBindings((current) => {
                      const { [filter.id]: _previous, ...rest } = current
                      return field === NONE ? rest : { ...rest, [filter.id]: field }
                    })
                  }
                >
                  <SelectTrigger aria-label={label}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('data.dashboard.bindingNone')}</SelectItem>
                    {fields.map((field) => (
                      <SelectItem key={field.key} value={field.key}>
                        {field.label[locale] ?? field.label.ru ?? field.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
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
  const [kind, setKind] = useState<'chart' | 'text'>('chart')
  const [chartId, setChartId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const { data: charts } = useQuery(objectListQuery({ spaceId, types: 'chart', limit: 100 }))
  const items = charts?.items ?? []
  const chart = items.find((item) => item.id === chartId)
  const ready = kind === 'chart' ? Boolean(chart) : Boolean(text.trim())
  const bottom = Math.max(0, ...tiles.map((tile) => tile.y + tile.h))

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
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() =>
                onAdd({
                  id: nextId(
                    't',
                    tiles.map((tile) => tile.id),
                  ),
                  kind,
                  ...(kind === 'chart' && chart
                    ? { chartId: chart.id, title: chart.title }
                    : { text: text.trim() }),
                  filterBindings: {},
                  x: 0,
                  y: bottom,
                  w: 6,
                  h: kind === 'chart' ? 4 : 2,
                })
              }
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <SegmentedControl
            aria-label={t('data.dashboard.addTileTitle')}
            value={kind}
            onValueChange={setKind}
            options={(['chart', 'text'] as const).map((value) => ({
              value,
              label: t(`data.dashboard.tileKinds.${value}`),
            }))}
          />
          {kind === 'chart' ? (
            items.length === 0 ? (
              <Callout tone="info">{t('data.dashboard.noCharts')}</Callout>
            ) : (
              <Field label={t('data.dashboard.pickChart')}>
                <Select value={chartId ?? undefined} onValueChange={setChartId}>
                  <SelectTrigger aria-label={t('data.dashboard.pickChart')}>
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
            )
          ) : (
            <Field label={t('data.dashboard.text')}>
              <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={t('data.dashboard.text')}
              />
            </Field>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
