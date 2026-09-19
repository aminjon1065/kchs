import {
  type Bbox,
  type DatasetField,
  type DatasetRowsQuery,
  type FieldType,
  type FilterNode,
  LAYER_FEATURES_LIMIT,
  type LayerRecord,
  type QueryResult,
} from '@kchs/contracts'
import { formatValue } from '@kchs/fields'
import {
  Callout,
  DataTable,
  type DataTableColumn,
  type DataTableSort,
  EmptyState,
  IconButton,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Focus, Table2, X, XSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery, objectQuery } from '~/shared/api/queries.js'
import { useFieldOptions } from '../../data/field-options.js'
import { datasetQuery } from '../../data/queries.js'
import { RowCard } from '../../data/row-card.js'
import { gisKeys } from '../queries.js'
import { useStudio } from './context.js'
import { atLeast, geometryBounds, unionBounds } from './geometry.js'
import { allOf, layerRowConditions, rowIdsOf } from './map-features.js'

/** Строк в странице; всего — не больше, чем объектов GeoJSON у слоя. */
const PAGE = 200
const MAX_ROWS = LAYER_FEATURES_LIMIT
/** Строк за запрос «приблизить к выделенным» (геометрии незагруженных строк). */
const ZOOM_BATCH = 1000

interface Row {
  id: string
  values: Record<string, unknown>
}

const NUMERIC = new Set<FieldType>([
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'rollup',
])
const UNSORTABLE = new Set<FieldType>(['geometry', 'json', 'multi_select', 'file'])

function widthOf(type: FieldType): number {
  if (NUMERIC.has(type)) return 120
  switch (type) {
    case 'boolean':
      return 88
    case 'date':
    case 'time':
      return 112
    case 'datetime':
      return 152
    case 'long_text':
      return 260
    default:
      return 180
  }
}

function toRows(result: QueryResult): { names: string[]; rows: Row[] } {
  const names = result.fields.map((field) => field.name)
  const idIndex = names.indexOf('_id')
  return {
    names,
    rows: result.rows.map((row) => ({
      id: String(row[idIndex]),
      values: Object.fromEntries(names.map((name, index) => [name, row[index]])),
    })),
  }
}

/**
 * Атрибутивная таблица активного слоя (P2-E02 S03, 07-gis-engine.md §6, ADR-0073):
 * строки датасета с политиками смотрящего и теми же условиями, что у тайлов
 * (фильтр слоя, фильтр карты, время), сортировка и поиск на сервере, «только в
 * охвате карты» (рамка у индекса GIST) и «только выделенные». Выделение строк и
 * объектов на карте — одно: щелчок по объекту отмечает и показывает строку,
 * строка — подсвечивает объект; двойной щелчок — карточка строки датасета.
 * Не больше 5 000 строк; у крупного слоя таблица сразу идёт по охвату карты.
 */
export function AttributeTable() {
  const t = useT()
  const studio = useStudio()
  const available = studio.layers.flatMap((item) => (item.layer?.dataAccess ? [item.layer] : []))
  const active = studio.activeLayerId ? studio.layerById.get(studio.activeLayerId) : undefined
  const layer = active?.dataAccess ? active : available[0]
  if (!layer) {
    return (
      <section
        aria-label={t('gis.attributes.label')}
        className="flex h-72 shrink-0 flex-col border-t border-line bg-surface"
      >
        <div className="flex justify-end px-2.5 py-1.5">
          <IconButton
            label={t('gis.attributes.close')}
            size="sm"
            onClick={() => studio.setAttributesOpen(false)}
          >
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>
        <EmptyState icon={<Table2 />} title={t('gis.attributes.noLayers')} />
      </section>
    )
  }
  return <LayerTable key={layer.id} layer={layer} available={available} />
}

function LayerTable({
  layer,
  available,
}: {
  layer: LayerRecord
  available: readonly LayerRecord[]
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const studio = useStudio()
  const { data: me } = useQuery(meQuery())
  const { data: dataset } = useQuery(datasetQuery(layer.datasetId))
  const { data: datasetObject } = useQuery(objectQuery(layer.datasetId))
  const fieldOptions = useFieldOptions(dataset?.fields ?? [])

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const [sort, setSort] = useState<DataTableSort[]>([])
  // Крупный слой — сразу по охвату карты: весь он в таблицу не поместится
  const [inExtent, setInExtent] = useState(layer.featureCount > MAX_ROWS)
  const [onlySelected, setOnlySelected] = useState(false)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)

  const selectedIds = useMemo(
    () => rowIdsOf(studio.selection, layer.id),
    [studio.selection, layer.id],
  )
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  // Охват карты — после остановки карты
  const [extent, setExtent] = useState<Bbox | null>(null)
  const { map, camera } = studio
  // biome-ignore lint/correctness/useExhaustiveDependencies: camera — сигнал, что карта остановилась в новом виде
  useEffect(() => {
    if (!inExtent || !map) return
    const timer = setTimeout(() => {
      try {
        const bounds = map.getBounds()
        setExtent([
          Math.max(-180, bounds.getWest()),
          Math.max(-90, bounds.getSouth()),
          Math.min(180, bounds.getEast()),
          Math.min(90, bounds.getNorth()),
        ])
      } catch {
        // Карта удалена
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [inExtent, map, camera])

  const conditions = layerRowConditions(layer, {
    filter: studio.layerFilters[layer.id] ?? null,
    time: studio.spec.time,
  })
  const where: FilterNode | undefined = allOf([
    ...conditions,
    ...(onlySelected ? [{ field: '_id', op: 'in' as const, value: selectedIds.map(Number) }] : []),
  ])
  const waiting = inExtent && !extent
  const query: Omit<DatasetRowsQuery, 'offset' | 'count'> = {
    ...(where ? { where } : {}),
    ...(inExtent && extent ? { bbox: { field: layer.geometryField, bbox: extent } } : {}),
    sort: sort.map((item) => ({ field: item.field, dir: item.direction })),
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    limit: PAGE,
  }
  const queryKey = JSON.stringify(query)

  const [rows, setRows] = useState<Row[]>([])
  const [names, setNames] = useState<string[] | null>(null)
  const [rowCount, setRowCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const generation = useRef(0)
  const fetching = useRef(false)

  const load = useCallback(
    async (offset: number, current: number) => {
      fetching.current = true
      try {
        const result = await http.post<QueryResult>(`/datasets/${layer.datasetId}/rows/query`, {
          ...(JSON.parse(queryKey) as typeof query),
          offset,
          count: offset === 0,
        })
        if (current !== generation.current) return
        const page = toRows(result)
        setNames(page.names)
        setRows((existing) => (offset === 0 ? page.rows : [...existing, ...page.rows]))
        if (offset === 0) setRowCount(result.rowCount ?? page.rows.length)
        setFailure(null)
      } catch (error) {
        if (current !== generation.current) return
        setFailure(error instanceof ApiError ? error.message : t('gis.attributes.failed'))
      } finally {
        if (current === generation.current) {
          fetching.current = false
          setLoading(false)
        }
      }
    },
    [layer.datasetId, queryKey, t],
  )

  // Новые условия — таблица читается заново с первой страницы
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads — намеренный повод перечитать
  useEffect(() => {
    if (waiting) return
    generation.current += 1
    setLoading(true)
    setRows([])
    void load(0, generation.current)
  }, [load, waiting, reloads])

  const limit = Math.min(rowCount, MAX_ROWS)
  const onEndReached = useCallback(() => {
    if (fetching.current || rows.length === 0 || rows.length >= limit) return
    void load(rows.length, generation.current)
  }, [load, rows.length, limit])

  const setLayerSelection = (ids: Iterable<string>) =>
    studio.setSelection([
      ...studio.selection.filter((ref) => ref.layerId !== layer.id),
      ...[...ids].map((rowId) => ({ layerId: layer.id, rowId })),
    ])

  const ctx = { locale, ...(me?.user.timezone ? { timezone: me.user.timezone } : {}) }
  const visible = names ? new Set(names) : null
  const columns: Array<DataTableColumn<Row>> = (dataset?.fields ?? [])
    .filter(
      (field: DatasetField) =>
        field.type !== 'geometry' && (visible ? visible.has(field.key) : true),
    )
    .map((field) => {
      const options = fieldOptions.get(field.key) ?? field.options ?? undefined
      const numeric = NUMERIC.has(field.type)
      return {
        key: field.key,
        header: field.label[locale] ?? field.label.ru ?? field.key,
        width: widthOf(field.type),
        align: numeric ? ('end' as const) : ('start' as const),
        sortable: !UNSORTABLE.has(field.type),
        cell: (row: Row) => {
          const value = row.values[field.key]
          if (value === null || value === undefined || value === '') {
            return <span className="text-fg-muted">—</span>
          }
          const text = formatValue(
            value,
            {
              type: field.type,
              ...(field.format ? { format: field.format } : {}),
              ...(options ? { options } : {}),
            },
            ctx,
          )
          return (
            <span className="truncate" title={text}>
              {text}
            </span>
          )
        },
      }
    })

  /** Охват выделенных строк слоя: загруженные — сразу, остальные — запросом. */
  const zoomToSelected = async () => {
    const known = new Map(rows.map((row) => [row.id, row.values[layer.geometryField]]))
    const boxes = selectedIds.map((id) => geometryBounds(known.get(id)))
    const missing = selectedIds.filter((id) => !known.has(id)).slice(0, ZOOM_BATCH)
    if (missing.length > 0) {
      try {
        const result = await http.post<QueryResult>(`/datasets/${layer.datasetId}/rows/query`, {
          where: { field: '_id', op: 'in', value: missing.map(Number) },
          limit: ZOOM_BATCH,
          count: false,
        })
        for (const row of toRows(result).rows) {
          boxes.push(geometryBounds(row.values[layer.geometryField]))
        }
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : t('gis.attributes.failed'))
      }
    }
    const bounds = unionBounds(boxes)
    if (bounds) studio.fitBounds(atLeast(bounds))
  }

  const level = datasetObject?.level ?? 'view'
  const canEditRows = ['edit', 'manage', 'owner'].includes(level)
  const revealId = selectedIds[selectedIds.length - 1] ?? null
  const shown = rows.length

  return (
    <section
      aria-label={t('gis.attributes.title', { name: layer.name })}
      className="flex h-72 shrink-0 flex-col border-t border-line bg-surface"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2.5 py-1.5">
        <Table2 className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <Select value={layer.id} onValueChange={(value) => studio.setActiveLayerId(value)}>
          <SelectTrigger className="h-7 w-52" aria-label={t('gis.attributes.layer')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {available.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="tabular text-xs text-fg-secondary" aria-live="polite">
          {loading && shown === 0
            ? t('gis.attributes.loading')
            : rowCount > MAX_ROWS
              ? t('gis.attributes.capped', { shown: MAX_ROWS, count: rowCount })
              : t('gis.attributes.count', { count: rowCount })}
          {selectedIds.length > 0
            ? ` · ${t('gis.attributes.selected', { count: selectedIds.length })}`
            : ''}
        </span>
        <SearchInput
          value={search}
          onValueChange={setSearch}
          onClear={() => setSearch('')}
          placeholder={t('gis.attributes.search')}
          aria-label={t('gis.attributes.search')}
          className="h-7 w-56"
        />
        <Switch
          checked={inExtent}
          onCheckedChange={(checked) => setInExtent(checked)}
          label={<span className="text-xs text-fg-secondary">{t('gis.attributes.inExtent')}</span>}
        />
        <Switch
          checked={onlySelected}
          disabled={selectedIds.length === 0 && !onlySelected}
          onCheckedChange={(checked) => setOnlySelected(checked)}
          label={
            <span className="text-xs text-fg-secondary">{t('gis.attributes.onlySelected')}</span>
          }
        />
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            label={t('gis.attributes.zoomToSelected')}
            size="sm"
            disabled={selectedIds.length === 0}
            onClick={() => void zoomToSelected()}
          >
            <Focus className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={t('gis.tools.clearSelection')}
            size="sm"
            disabled={selectedIds.length === 0}
            onClick={() => setLayerSelection([])}
          >
            <XSquare className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={t('gis.attributes.close')}
            size="sm"
            onClick={() => studio.setAttributesOpen(false)}
          >
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>
      {failure ? (
        <Callout tone="danger" className="m-2">
          {failure}
        </Callout>
      ) : null}
      <DataTable<Row>
        aria-label={t('gis.attributes.title', { name: layer.name })}
        className="min-h-0 flex-1"
        rows={rows}
        getRowId={(row) => row.id}
        columns={columns}
        sort={sort}
        onSortChange={setSort}
        selectable
        selection={selected}
        onSelectionChange={(next) => setLayerSelection(next)}
        onRowClick={(row) => setLayerSelection([row.id])}
        onRowOpen={(row) => setOpenRow(row.id)}
        revealId={revealId}
        onEndReached={onEndReached}
        loading={loading || waiting}
        empty={
          <p className="text-center text-sm text-fg-muted">
            {onlySelected
              ? t('gis.attributes.noSelected')
              : inExtent
                ? t('gis.attributes.emptyExtent')
                : t('gis.attributes.empty')}
          </p>
        }
      />
      {openRow && dataset ? (
        <RowCard
          dataset={dataset}
          rowId={openRow}
          canEdit={canEditRows}
          onClose={() => setOpenRow(null)}
          onChanged={() => {
            setReloads((value) => value + 1)
            // Новая версия данных — новый адрес тайлов слоя
            void client.invalidateQueries({ queryKey: gisKeys.layer(layer.id) })
          }}
        />
      ) : null}
    </section>
  )
}
