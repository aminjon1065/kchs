import {
  type LayerStyle,
  LayerStyle as LayerStyleSchema,
  type Locale,
  type PassportChild,
  type TerritoryPassport,
} from '@kchs/contracts'
import { formatNumber } from '@kchs/fields'
import type { StyleField } from '@kchs/map-style'
import {
  DataTable,
  type DataTableColumn,
  EmptyState,
  Field,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ChoroplethMap } from '../choropleth/choropleth-map.js'
import type { GeoCollection } from '../choropleth/geojson.js'
import { childShapesQuery } from './queries.js'

type Measure = 'rows' | 'rate'
const VALUE = 'value'
/** Доля на столько жителей — как в хороплет-мастере по умолчанию. */
const PER = 1000

const MINI_STYLE: LayerStyle = LayerStyleSchema.parse({
  version: 1,
  geometry: 'polygon',
  renderer: { kind: 'graduated', field: VALUE, method: 'jenks', classes: 5 },
  polygon: { fillOpacity: 0.75, outline: { width: 0.75, color: 'auto' } },
})

interface ChildRow extends PassportChild {
  rows: number
  rate: number | null
}

/**
 * Вкладка «Дочерние территории» паспорта: таблица единиц с населением,
 * площадью и строками выбранного датасета, мини-хороплет по ним; щелчок по
 * строке или району на карте — паспорт дочерней единицы.
 */
export function PassportChildren({
  territoryId,
  passport,
  onOpen,
}: {
  territoryId: string
  passport: TerritoryPassport
  onOpen: (child: PassportChild) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const withChildren = passport.datasets.filter((item) => item.rows !== null)
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [measure, setMeasure] = useState<Measure>('rate')
  const dataset = withChildren.find((item) => item.id === datasetId) ?? withChildren[0] ?? null
  const shapes = useQuery({
    ...childShapesQuery(territoryId),
    enabled: passport.children.some((child) => child.hasGeometry),
  })

  const rows = useMemo<ChildRow[]>(
    () =>
      passport.children.map((child) => {
        const count = dataset?.children[child.id] ?? 0
        return {
          ...child,
          rows: count,
          rate: child.population ? (count / child.population) * PER : null,
        }
      }),
    [passport.children, dataset],
  )
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const rateLabel = t('gis.passport.ratePer', { n: formatNumber(PER, {}, { locale }) })
  const valueLabel = measure === 'rate' ? rateLabel : t('gis.passport.rowsCount')

  const features = useMemo<GeoCollection | null>(() => {
    if (!shapes.data) return null
    return {
      type: 'FeatureCollection',
      features: shapes.data.features.map((feature) => {
        const row = byId.get(String(feature.properties.id))
        const value = row ? (measure === 'rate' ? row.rate : row.rows) : null
        return { ...feature, properties: { ...feature.properties, [VALUE]: value } }
      }),
    }
  }, [shapes.data, byId, measure])
  const fields = useMemo<StyleField[]>(
    () => [
      {
        key: VALUE,
        type: measure === 'rate' ? 'number' : 'integer',
        label: { ru: valueLabel, en: valueLabel, tg: valueLabel },
        // Доля — без заданной точности: легенда подберёт её по значениям
        format: measure === 'rate' ? null : { precision: 0 },
      },
    ],
    [valueLabel, measure],
  )

  if (passport.children.length === 0) {
    return <EmptyState title={t('gis.passport.noChildren')} />
  }

  const nameOf = (child: PassportChild) => child.name[locale] ?? child.name.ru
  const number = (value: number | null, precision?: number) =>
    value === null
      ? '—'
      : formatNumber(value, precision === undefined ? {} : { precision }, { locale })
  const columns: Array<DataTableColumn<ChildRow>> = [
    { key: 'name', header: t('gis.passport.childName'), width: 220, cell: nameOf },
    { key: 'code', header: t('gis.territories.code'), width: 110, cell: (row) => row.code },
    {
      key: 'population',
      header: t('gis.territories.population'),
      width: 120,
      align: 'end',
      cell: (row) => number(row.population, 0),
    },
    {
      key: 'area',
      header: t('gis.territories.area'),
      width: 110,
      align: 'end',
      cell: (row) => number(row.areaKm2, 0),
    },
    {
      key: 'rows',
      header: t('gis.passport.rowsCount'),
      width: 110,
      align: 'end',
      cell: (row) => number(row.rows, 0),
    },
    {
      key: 'rate',
      header: rateLabel,
      width: 150,
      align: 'end',
      cell: (row) => number(row.rate),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {withChildren.length > 0 ? (
          <Field label={t('gis.passport.childrenDataset')} className="w-72">
            <Select value={dataset?.id ?? ''} onValueChange={setDatasetId}>
              <SelectTrigger aria-label={t('gis.passport.childrenDataset')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withChildren.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <SegmentedControl
          aria-label={t('gis.passport.childrenMeasure')}
          value={measure}
          onValueChange={setMeasure}
          options={[
            { value: 'rate', label: rateLabel },
            { value: 'rows', label: t('gis.passport.rowsCount') },
          ]}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <DataTable
          rows={rows}
          getRowId={(row) => row.id}
          columns={columns}
          className="h-72"
          aria-label={t('gis.passport.tabs.children')}
          onRowClick={onOpen}
          onRowOpen={onOpen}
        />
        {features ? (
          <ChoroplethMap
            className="h-[420px] overflow-hidden rounded-md border border-line"
            features={features}
            style={MINI_STYLE}
            fields={fields}
            idProperty="id"
            onSelect={(id) => {
              const child = byId.get(id)
              if (child) onOpen(child)
            }}
            aria-label={t('gis.passport.childrenMap')}
          />
        ) : shapes.isLoading ? (
          <Skeleton className="h-[420px] w-full" />
        ) : null}
      </div>
    </div>
  )
}
