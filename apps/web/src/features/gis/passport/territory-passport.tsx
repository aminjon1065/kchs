import type {
  Locale,
  PassportChild,
  PassportDataset,
  PassportPeriod,
  Territory,
} from '@kchs/contracts'
import { formatDate, formatNumber } from '@kchs/fields'
import type { LegendModel } from '@kchs/map-style'
import {
  Badge,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  MapLegend,
  ObjectIcon,
  renderMapIcon,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Gauge, Layers, Map as MapIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { territoriesQuery, territoryQuery } from '../queries.js'
import { useOpenPassport } from '../territory-link.js'
import { PassportChildren } from './passport-children.js'
import { PassportData } from './passport-data.js'
import { PassportIndicators } from './passport-indicators.js'
import { type PassportLayer, PassportMap } from './passport-map.js'
import { PassportMetricsDialog } from './passport-metrics.js'
import { PassportTasks } from './passport-tasks.js'
import { passportQuery } from './queries.js'

const PERIODS: readonly PassportPeriod[] = ['12m', 'year', 'all']
type Tab = 'data' | 'objects' | 'documents' | 'tasks' | 'children'

/**
 * Паспорт территории (07-gis-engine.md §11, 03-screens.md §11, P2-E04 S05,
 * ADR-0077): шапка с крошками иерархии и переключателем единицы уровня, сетка
 * показателей за период, карта с границей и объектами внутри, вкладки «Данные»,
 * «Объекты», «Документы», «Поручения», «Дочерние территории». Всё — с правами
 * и политиками смотрящего; переходы — во вкладки с условием территории.
 */
export function TerritoryPassport({ territoryId }: { territoryId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const openTab = useWorkspace((s) => s.openTab)
  const openPassport = useOpenPassport()
  const [period, setPeriod] = useState<PassportPeriod>('12m')
  const [tab, setTab] = useState<Tab>('data')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [heatmap, setHeatmap] = useState(false)
  const [legends, setLegends] = useState<ReadonlyMap<string, LegendModel>>(new Map())
  const [metricsOpen, setMetricsOpen] = useState(false)

  const territory = useQuery(territoryQuery(territoryId))
  const passport = useQuery(passportQuery(territoryId, period))
  const { data: all = [] } = useQuery(territoriesQuery())

  const nameOf = (item: Pick<Territory, 'name'>) => item.name[locale] ?? item.name.ru
  // Объекты на карте: первый слой каждого датасета с полем территории
  const objectLayers = useMemo(
    () =>
      (passport.data?.datasets ?? []).flatMap((dataset) => {
        const layer = dataset.layers[0]
        return layer
          ? [{ layerId: layer.id, name: layer.name, territoryField: dataset.territoryField }]
          : []
      }),
    [passport.data],
  )
  const shownLayers: PassportLayer[] = useMemo(
    () => objectLayers.filter((layer) => !hidden.has(layer.layerId)),
    [objectLayers, hidden],
  )

  if (territory.isLoading) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (territory.error || !territory.data) {
    return <ErrorState onRetry={() => void territory.refetch()} />
  }
  const unit = territory.data
  const siblings = all.filter(
    (item) => item.parentId === unit.parentId && item.level === unit.level,
  )
  const population = unit.attributes.population
  const openDataset = (dataset: PassportDataset) => {
    setDatasetId(dataset.id)
    setTab('data')
  }
  const openChild = (child: Pick<PassportChild, 'id' | 'name'>) => openPassport(child)

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-4 p-5">
        <header className="flex flex-col gap-2">
          {unit.path.length > 0 ? (
            <Breadcrumbs
              items={unit.path.map((item) => ({
                id: item.id,
                label: nameOf(item),
                onClick: () => openPassport(item),
              }))}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <ObjectIcon type="territory" className="size-5 text-fg-muted" />
            <h2 className="text-lg font-semibold text-fg">{nameOf(unit)}</h2>
            <Badge size="sm">{t(`gis.territories.levels.${unit.level}`)}</Badge>
            <span className="text-xs text-fg-muted">{unit.code}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {siblings.length > 1 ? (
                <Select
                  value={unit.id}
                  onValueChange={(id) => {
                    const next = siblings.find((item) => item.id === id)
                    if (next && next.id !== unit.id) openPassport(next)
                  }}
                >
                  <SelectTrigger
                    className="h-7 w-56"
                    aria-label={t('gis.passport.switchUnit', {
                      level: t(`gis.territories.levels.${unit.level}`),
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {siblings.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {nameOf(item)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <SegmentedControl
                size="sm"
                aria-label={t('gis.passport.period')}
                value={period}
                onValueChange={setPeriod}
                options={PERIODS.map((value) => ({
                  value,
                  label: t(`gis.passport.periods.${value}`),
                }))}
              />
            </div>
          </div>
          <p className="text-xs text-fg-secondary">
            {[
              unit.kind,
              typeof population === 'number'
                ? t('gis.passport.population', { n: formatNumber(population, {}, { locale }) })
                : null,
              unit.areaKm2 !== null
                ? t('gis.passport.area', {
                    n: formatNumber(unit.areaKm2, { precision: 0 }, { locale }),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </header>

        <section className="flex flex-col gap-2" aria-label={t('gis.passport.indicators')}>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-fg">{t('gis.passport.indicators')}</h3>
            {passport.data?.window ? (
              <span className="text-xs text-fg-muted">
                {t('gis.passport.window', {
                  from: formatDate(passport.data.window.from, { locale }),
                  to: formatDate(passport.data.window.to, { locale }),
                })}
              </span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              icon={<Gauge className="size-3.5" />}
              onClick={() => setMetricsOpen(true)}
            >
              {t('gis.passport.metrics')}
            </Button>
          </div>
          {passport.error ? (
            <ErrorState onRetry={() => void passport.refetch()} />
          ) : (
            <PassportIndicators
              passport={passport.data}
              loading={passport.isLoading}
              onOpenDataset={openDataset}
              onOpenTasks={() => setTab('tasks')}
            />
          )}
        </section>

        <section className="grid min-w-0 gap-3 lg:h-[440px] lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-h-[360px] flex-col overflow-hidden rounded-lg border border-line">
            {unit.hasGeometry ? (
              <PassportMap
                territoryId={unit.id}
                name={nameOf(unit)}
                bbox={unit.bbox}
                layers={shownLayers}
                heatmap={heatmap}
                onChild={(id) => {
                  const child = unit.children.find((item) => item.id === id)
                  if (child) openChild(child)
                }}
                onLegends={setLegends}
              />
            ) : (
              <EmptyState
                icon={<MapIcon className="size-5" />}
                title={t('gis.territories.noBoundary')}
              />
            )}
          </div>
          <Card title={t('gis.passport.objectsOnMap')} padded className="min-h-0">
            <div className="flex max-h-full flex-col gap-3 overflow-y-auto">
              {objectLayers.length === 0 ? (
                <p className="text-xs text-fg-muted">{t('gis.passport.noLayers')}</p>
              ) : (
                objectLayers.map((layer) => (
                  <div key={layer.layerId} className="flex flex-col gap-2">
                    <Checkbox
                      checked={!hidden.has(layer.layerId)}
                      onCheckedChange={(value) =>
                        setHidden((previous) => {
                          const next = new Set(previous)
                          if (value === true) next.delete(layer.layerId)
                          else next.add(layer.layerId)
                          return next
                        })
                      }
                      label={layer.name}
                    />
                    {!hidden.has(layer.layerId) && legends.get(layer.layerId)?.show ? (
                      <MapLegend
                        legend={legends.get(layer.layerId) as LegendModel}
                        renderIcon={renderMapIcon}
                      />
                    ) : null}
                  </div>
                ))
              )}
              {objectLayers.length > 0 ? (
                <Switch
                  checked={heatmap}
                  onCheckedChange={setHeatmap}
                  label={t('gis.passport.heatmap')}
                />
              ) : null}
              <p className="text-xs text-fg-muted">{t('gis.passport.mapHint')}</p>
            </div>
          </Card>
        </section>

        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="data" count={passport.data?.datasets.length}>
              {t('gis.passport.tabs.data')}
            </TabsTrigger>
            <TabsTrigger value="objects" count={objectLayers.length}>
              {t('gis.passport.tabs.objects')}
            </TabsTrigger>
            <TabsTrigger value="documents">{t('gis.passport.tabs.documents')}</TabsTrigger>
            <TabsTrigger value="tasks" count={passport.data?.tasks.open}>
              {t('gis.passport.tabs.tasks')}
            </TabsTrigger>
            <TabsTrigger value="children" count={unit.children.length}>
              {t('gis.passport.tabs.children')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="data" className="pt-4">
            <PassportData
              territoryId={unit.id}
              territoryName={nameOf(unit)}
              datasets={passport.data?.datasets ?? []}
              selected={datasetId}
              onSelect={setDatasetId}
            />
          </TabsContent>
          <TabsContent value="objects" className="pt-4">
            {objectLayers.length === 0 ? (
              <EmptyState icon={<Layers className="size-5" />} title={t('gis.passport.noLayers')} />
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
                {(passport.data?.datasets ?? []).flatMap((dataset) =>
                  dataset.layers.map((layer) => (
                    <li key={layer.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <ObjectIcon type="layer" className="size-4 shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1 truncate text-fg">{layer.name}</span>
                      <span className="shrink-0 truncate text-xs text-fg-muted">
                        {dataset.name}
                        {dataset.rows !== null
                          ? ` · ${t('gis.passport.objectsIn', {
                              count: dataset.rows,
                              n: formatNumber(dataset.rows, {}, { locale }),
                            })}`
                          : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          openTab({
                            kind: 'object',
                            objectId: layer.id,
                            objectType: 'layer',
                            title: layer.name,
                            mode: 'permanent',
                          })
                        }
                      >
                        {t('gis.passport.openLayer')}
                      </Button>
                    </li>
                  )),
                )}
              </ul>
            )}
          </TabsContent>
          <TabsContent value="documents" className="pt-4">
            <EmptyState
              title={t('gis.passport.documentsTitle')}
              description={t('gis.passport.documentsHint')}
            />
          </TabsContent>
          <TabsContent value="tasks" className="pt-4">
            <PassportTasks territoryId={unit.id} />
          </TabsContent>
          <TabsContent value="children" className="pt-4">
            {passport.data ? (
              <PassportChildren territoryId={unit.id} passport={passport.data} onOpen={openChild} />
            ) : (
              <Skeleton className="h-64 w-full" />
            )}
          </TabsContent>
        </Tabs>
      </div>
      {metricsOpen && passport.data ? (
        <PassportMetricsDialog
          territory={unit}
          metrics={passport.data.metrics}
          onClose={() => setMetricsOpen(false)}
        />
      ) : null}
    </div>
  )
}
