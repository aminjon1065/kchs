import {
  type DashboardFilter,
  type DashboardTile,
  type DatasetRecord,
  dashboardMapFilters,
  type MapCamera,
  type MapTileOptions,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Crosshair, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { MapEmbed } from '~/features/gis/map-embed.js'
import { layerQuery, mapQuery } from '~/features/gis/queries.js'
import { datasetQuery } from './queries.js'

const NONE = '__none'
const EMPTY_OPTIONS: MapTileOptions = { camera: null, bindings: {} }

/**
 * Плитка-карта дашборда (06-analytics-engine.md §9, P2-E02 S04, ADR-0074):
 * сохранённая карта со своим видом; фильтры дашборда, привязанные к полям
 * датасетов её слоёв, уходят тайлам этих слоёв условием `f`. В правке — вид
 * плитки запоминается из текущего положения карты.
 */
export function DashboardMapTile({
  tile,
  filters,
  values,
  editing,
  onChange,
  refreshMs = null,
}: {
  tile: DashboardTile
  filters: readonly DashboardFilter[]
  values: Readonly<Record<string, unknown>>
  editing: boolean
  onChange: (tile: DashboardTile) => void
  /** Перечитывание слоёв карты вместе с данными дашборда (TV, автообновление), мс. */
  refreshMs?: number | null
}) {
  const t = useT()
  const [current, setCurrent] = useState<MapCamera | null>(null)
  if (!tile.mapId) return <Callout tone="danger">{t('data.dashboard.failed')}</Callout>
  const options = tile.map ?? EMPTY_OPTIONS
  const byDataset = dashboardMapFilters(filters, options, values)
  const setCamera = (camera: MapCamera | null) => onChange({ ...tile, map: { ...options, camera } })
  return (
    <MapEmbed
      mapId={tile.mapId}
      camera={options.camera}
      filter={(layer) => byDataset[layer.datasetId] ?? null}
      onCameraChange={setCurrent}
      refreshMs={refreshMs}
      actions={
        editing ? (
          <>
            <IconButton
              label={t('data.dashboard.map.saveView')}
              size="sm"
              disabled={!current}
              onClick={() => current && setCamera(current)}
            >
              <Crosshair className="size-3.5" aria-hidden />
            </IconButton>
            {options.camera ? (
              <IconButton
                label={t('data.dashboard.map.resetView')}
                size="sm"
                onClick={() => setCamera(null)}
              >
                <RotateCcw className="size-3.5" aria-hidden />
              </IconButton>
            ) : null}
          </>
        ) : null
      }
    />
  )
}

/** Поле датасета, к которому фильтр привязывается по умолчанию. */
function suggestedField(
  filter: DashboardFilter,
  dataset: DatasetRecord,
  timeFields: ReadonlySet<string>,
): string | null {
  if (filter.kind === 'territory') return dataset.territoryField
  if (filter.kind === 'period') {
    const time = dataset.fields.find((field) => timeFields.has(field.key))?.key
    return time ?? dataset.timeField
  }
  return null
}

/**
 * Привязка фильтров дашборда к плитке-карте: для каждого фильтра и каждого
 * датасета слоёв карты — поле, по которому фильтр ограничивает тайлы. Для
 * нового фильтра подставлены поле территории и поле времени слоя.
 */
export function MapBindingsDialog({
  tile,
  filters,
  onClose,
  onSave,
}: {
  tile: DashboardTile
  filters: readonly DashboardFilter[]
  onClose: () => void
  onSave: (bindings: MapTileOptions['bindings']) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const record = useQuery({ ...mapQuery(tile.mapId ?? ''), enabled: Boolean(tile.mapId) })
  const layers = useQueries({
    queries: (record.data?.spec.layers ?? []).map((entry) => ({
      ...layerQuery(entry.layerId),
      retry: false,
    })),
  })
  const loaded = layers.flatMap((query) => (query.data?.dataAccess ? [query.data] : []))
  const datasetIds = [...new Set(loaded.map((layer) => layer.datasetId))]
  const datasets = useQueries({
    queries: datasetIds.map((id) => ({ ...datasetQuery(id), retry: false })),
  })
  const timeFields = new Set(
    loaded.flatMap((layer) => (layer.style.time ? [layer.style.time.field] : [])),
  )
  const saved = tile.map?.bindings ?? {}
  const [bindings, setBindings] = useState<MapTileOptions['bindings'] | null>(null)
  const ready = datasets.length > 0 && datasets.every((query) => query.data)
  const current: MapTileOptions['bindings'] =
    bindings ??
    (ready
      ? Object.fromEntries(
          filters.map((filter) => {
            const fields = { ...(saved[filter.id] ?? {}) }
            if (!saved[filter.id]) {
              for (const query of datasets) {
                const dataset = query.data as DatasetRecord
                const field = suggestedField(filter, dataset, timeFields)
                if (field) fields[dataset.id] = field
              }
            }
            return [filter.id, fields]
          }),
        )
      : saved)

  const set = (filterId: string, datasetId: string, field: string) => {
    const next = { ...current }
    const fields = { ...(next[filterId] ?? {}) }
    if (field === NONE) delete fields[datasetId]
    else fields[datasetId] = field
    next[filterId] = fields
    setBindings(next)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={tile.title ?? t('data.dashboard.tileKinds.map')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              onClick={() =>
                onSave(
                  Object.fromEntries(
                    Object.entries(current).filter(([, fields]) => Object.keys(fields).length > 0),
                  ),
                )
              }
            >
              {t('data.dashboard.done')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs text-fg-muted">{t('data.dashboard.map.bindingsHint')}</p>
          {!ready ? (
            datasetIds.length === 0 && !record.isLoading && layers.every((q) => !q.isLoading) ? (
              <Callout tone="info">{t('data.dashboard.map.noLayers')}</Callout>
            ) : (
              <Skeleton className="h-24 w-full" />
            )
          ) : (
            filters.map((filter) => (
              <fieldset key={filter.id} className="flex flex-col gap-2">
                <legend className="mb-1 text-xs font-semibold text-fg">
                  {filter.label[locale] ?? filter.label.ru}
                </legend>
                {datasets.map((query) => {
                  const dataset = query.data as DatasetRecord
                  const label = t('data.dashboard.map.binding', {
                    filter: filter.label[locale] ?? filter.label.ru,
                    dataset: dataset.name,
                  })
                  return (
                    <Field key={dataset.id} label={dataset.name}>
                      <Select
                        value={current[filter.id]?.[dataset.id] ?? NONE}
                        onValueChange={(field) => set(filter.id, dataset.id, field)}
                      >
                        <SelectTrigger aria-label={label}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>{t('data.dashboard.bindingNone')}</SelectItem>
                          {dataset.fields
                            .filter((field) => field.type !== 'geometry')
                            .map((field) => (
                              <SelectItem key={field.key} value={field.key}>
                                {field.label[locale] ?? field.label.ru ?? field.key}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  )
                })}
              </fieldset>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
