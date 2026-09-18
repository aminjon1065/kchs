import type { ChartPick } from '@kchs/chart-spec'
import type {
  DashboardFilter,
  DashboardTile,
  DashboardTileData,
  DatasetField,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  Card,
  Chart,
  cn,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  NoAccessState,
  NumberTile,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, SlidersHorizontal, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { meQuery } from '~/shared/api/queries.js'
import { metricTileModel, periodText } from './metric-format.js'
import { chartQuery, datasetQuery, metricQuery } from './queries.js'

/** Высота строки сетки, px: обычный вид — auto-rows-[80px], TV — auto-rows-[112px]. */
const ROW = 80
const TV_ROW = 112
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
/** Плитки с привязкой к фильтрам дашборда. */
const BINDABLE = new Set(['chart', 'metric'])

function tileTitle(
  tile: DashboardTile,
  data: DashboardTileData | undefined,
  t: (key: string) => string,
) {
  if (tile.title) return tile.title
  if (tile.kind === 'metric') return data?.metric?.name ?? t('data.dashboard.tileKinds.metric')
  return t(`data.dashboard.tileKinds.${tile.kind === 'text' ? 'text' : 'chart'}`)
}

/**
 * Плитка дашборда: график, показатель или текст; в режиме правки — размер,
 * порядок и привязка фильтров. `large` — TV-режим: крупнее и без правки.
 */
export function TileCard({
  tile,
  data,
  pending,
  editing,
  filters,
  onChange,
  onMove,
  onRemove,
  onPick,
  large = false,
}: {
  tile: DashboardTile
  data: DashboardTileData | undefined
  pending: boolean
  editing: boolean
  filters: DashboardFilter[]
  onChange: (tile: DashboardTile) => void
  onMove: (delta: number) => void
  onRemove: () => void
  /** Щелчок по элементу графика вне режима правки — детализация до строк. */
  onPick?: (pick: ChartPick) => void
  large?: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const [bindings, setBindings] = useState(false)
  const height = Math.min(tile.h, 8)

  let body: ReactNode
  if (tile.kind === 'text' || tile.kind === 'heading') {
    body = (
      <div
        className={cn(
          'h-full overflow-auto whitespace-pre-wrap text-fg',
          large ? 'text-md' : 'text-sm',
        )}
      >
        {tile.text}
      </div>
    )
  } else if (data?.error === 'no_access') {
    body = <NoAccessState />
  } else if (data?.error) {
    body = <Callout tone="danger">{t('data.dashboard.failed')}</Callout>
  } else if (tile.kind === 'metric' && data?.metric) {
    body = (
      <NumberTile
        size={large ? 'lg' : 'md'}
        // Подпись внутри плитки — период: имя показателя уже в заголовке карточки
        model={metricTileModel(data.metric, t, locale, periodText(data.metric.period, t, locale))}
        className="h-full border-0 bg-transparent p-0"
      />
    )
  } else if (data?.spec && data.result) {
    body = (
      <Chart
        spec={data.spec}
        result={data.result}
        height={height * (large ? TV_ROW : ROW) - 64}
        pending={pending}
        {...(me?.user.timezone ? { timezone: me.user.timezone } : {})}
        {...(onPick && !editing ? { onElementClick: onPick } : {})}
      />
    )
  } else {
    body = <Skeleton className="h-full w-full" />
  }

  return (
    <Card
      className={cn(COL_SPAN[tile.w] ?? 'col-span-6', ROW_SPAN[height], 'min-w-0 overflow-hidden')}
      title={tileTitle(tile, data, t)}
      action={
        editing ? (
          // Узкой плитке (показатель — 3/12) кнопки правки переносятся, а не прячут заголовок
          <span className="flex flex-wrap items-center justify-end gap-1">
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
            {BINDABLE.has(tile.kind) && filters.length > 0 ? (
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

/** Поля источника плитки: датасет графика (сохранённого или встроенного) или показателя. */
function useTileFields(tile: DashboardTile): DatasetField[] {
  const chart = useQuery({ ...chartQuery(tile.chartId ?? ''), enabled: Boolean(tile.chartId) })
  const metric = useQuery({ ...metricQuery(tile.metricId ?? ''), enabled: Boolean(tile.metricId) })
  const spec = tile.spec ?? chart.data?.spec
  const source = spec && 'query' in spec.data ? spec.data.query.source : null
  const datasetId =
    tile.kind === 'metric'
      ? (metric.data?.datasetId ?? '')
      : source?.kind === 'dataset'
        ? source.id
        : ''
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
        title={
          tile.title ?? t(`data.dashboard.tileKinds.${tile.kind === 'metric' ? 'metric' : 'chart'}`)
        }
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
          {tile.kind === 'metric' ? (
            <p className="text-xs text-fg-muted">{t('data.dashboard.metricBindingsHint')}</p>
          ) : null}
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
