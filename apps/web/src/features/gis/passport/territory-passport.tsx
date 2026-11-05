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
  OpsBand,
  renderMapIcon,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useMapTheme,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Gauge, Layers, Map as MapIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { territoriesQuery, territoryQuery } from '~/entities/territory/queries.js'
import { territoryDocumentsQuery } from '~/features/documents/index.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { useOpenPassport } from '../../../entities/territory/territory-link.js'
import { LEVEL_WORD } from '../hazard-legend.js'
import { useMapOverlays } from '../overlay-layers.js'
import { PassportChildren } from './passport-children.js'
import { PassportData } from './passport-data.js'
import { PassportDocuments } from './passport-documents.js'
import { hazardFor } from './passport-hazard.js'
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
  const locale = useLocale() as Locale
  const openTab = useWorkspace((s) => s.openTab)
  const openPassport = useOpenPassport()
  const [period, setPeriod] = useState<PassportPeriod>('12m')
  const [tab, setTab] = useState<Tab>('data')
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [heatmap, setHeatmap] = useState(false)
  const [legends, setLegends] = useState<ReadonlyMap<string, LegendModel>>(new Map())
  const [metricsOpen, setMetricsOpen] = useState(false)
  // Тема карты — от корня паспорта: наложения (зоны предупреждений) рисуются одним набором
  // поставщиков и для карты, и для плашки обстановки
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const overlays = useMapOverlays(theme)

  const territory = useQuery(territoryQuery(territoryId))
  const passport = useQuery(passportQuery(territoryId, period))
  const documents = useQuery(territoryDocumentsQuery(territoryId))
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
  const hazard = useMemo(
    () => (territory.data ? hazardFor(territory.data, overlays.zones) : null),
    [territory.data, overlays.zones],
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

  // Второе название — на другом языке справочника: русское рядом с таджикским и наоборот
  const otherLocale: Locale = locale === 'tg' ? 'ru' : 'tg'
  const otherName = unit.name[otherLocale]
  const showOther = Boolean(otherName) && otherName !== nameOf(unit)

  return (
    <div ref={setRoot} className="@container h-full overflow-y-auto bg-canvas">
      {/* Поставщики наложений без разметки: зоны для карты и плашки обстановки */}
      {overlays.feeds}
      <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-7 pt-5 pb-6">
        <header className="flex flex-col gap-1.5">
          {unit.path.length > 0 ? (
            <Breadcrumbs
              items={unit.path.map((item) => ({
                id: item.id,
                label: nameOf(item),
                onClick: () => openPassport(item),
              }))}
            />
          ) : null}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-2xl text-fg">{nameOf(unit)}</h2>
              {showOther ? (
                <span lang={otherLocale} className="text-md text-fg-muted">
                  {otherName}
                </span>
              ) : null}
              <span className="rounded-sm border border-line-strong px-1.5 font-mono text-xs leading-5 text-fg-secondary">
                {unit.code}
              </span>
              <Badge size="sm">{t(`gis.territories.levels.${unit.level}`)}</Badge>
              {/* Вид единицы — если он не повторяет уровень («город», а не «район» у района) */}
              {unit.kind &&
              unit.kind.toLowerCase() !==
                t(`gis.territories.levels.${unit.level}`).toLowerCase() ? (
                <span className="text-sm text-fg-secondary">{unit.kind}</span>
              ) : null}
            </div>
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
        </header>

        {/* Обстановка по территории (ADR-0230): самая строгая зона действующих
            предупреждений этой единицы, её предков или вложенных — цвет с цифрой уровня */}
        {hazard ? (
          <OpsBand
            level={hazard.zone.level}
            levelLabel={t(`shell.opsBand.levels.${LEVEL_WORD[hazard.zone.level]}`)}
            title={hazard.zone.title}
            details={
              hazard.territory && hazard.territory.id !== unit.id
                ? t('gis.passport.hazardAt', { name: nameOf(hazard.territory) })
                : undefined
            }
            meta={hazard.more > 0 ? t('shell.opsBand.more', { count: hazard.more }) : undefined}
            actions={
              hazard.zone.objectId ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    openTab({
                      kind: 'object',
                      objectId: hazard.zone.objectId as string,
                      objectType: hazard.zone.objectType ?? 'warning',
                      title: hazard.zone.title,
                      mode: 'permanent',
                    })
                  }
                >
                  {t('gis.passport.openWarning')}
                </Button>
              ) : undefined
            }
            className="overflow-hidden rounded-lg border"
          />
        ) : null}

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
              leading={
                <>
                  {typeof population === 'number' ? (
                    <StatTile
                      label={t('gis.territories.population')}
                      value={formatNumber(population, {}, { locale })}
                    />
                  ) : null}
                  {unit.areaKm2 !== null ? (
                    <StatTile
                      label={t('gis.passport.areaLabel')}
                      value={formatNumber(unit.areaKm2, { precision: 0 }, { locale })}
                      unit={t('gis.passport.areaUnit')}
                    />
                  ) : null}
                </>
              }
              onOpenDataset={openDataset}
              onOpenTasks={() => setTab('tasks')}
            />
          )}
        </section>

        <section className="grid min-w-0 gap-3 @5xl:h-110 @5xl:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex min-h-90 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
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
                overlay={{
                  sources: overlays.sources,
                  layers: overlays.layers,
                  rows: overlays.rows,
                }}
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
              {overlays.rows.map((row) => (
                <Checkbox
                  key={row.id}
                  checked={row.visible}
                  onCheckedChange={(value) => overlays.toggle(row.id, value === true)}
                  label={`${row.label} · ${row.count}`}
                />
              ))}
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

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as Tab)}
          className="flex flex-col rounded-xl border border-line bg-surface px-4 pb-4 shadow-sm"
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="data" count={passport.data?.datasets.length}>
              {t('gis.passport.tabs.data')}
            </TabsTrigger>
            <TabsTrigger value="objects" count={objectLayers.length}>
              {t('gis.passport.tabs.objects')}
            </TabsTrigger>
            <TabsTrigger value="documents" count={documents.data?.total}>
              {t('gis.passport.tabs.documents')}
            </TabsTrigger>
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
            <PassportDocuments territoryId={unit.id} />
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
