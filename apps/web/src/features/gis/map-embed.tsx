import type {
  Bbox,
  DatasetRecord,
  FilterNode,
  LayerRecord,
  MapCamera,
  MapLayerEntry,
} from '@kchs/contracts'
import {
  Button,
  Callout,
  cn,
  IconButton,
  MapCanvas,
  type MapClickEvent,
  MapLegend,
  NoAccessState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  renderMapIcon,
  Skeleton,
  useMapTheme,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ExternalLink, List, Map as MapIcon } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { datasetQuery } from '../data/queries.js'
import { registerPmtilesProtocol, useBasemapStyle } from './basemaps.js'
import { FeatureCard } from './feature-card.js'
import { layerSourceId, useRenderedLayers } from './layer-render.js'
import { useMapSlot } from './map-slots.js'
import { layerQuery, mapQuery } from './queries.js'

/** Вид по умолчанию до охвата слоя — Таджикистан, как у новой карты. */
const DEFAULT_CAMERA: MapCamera = { center: [69, 38.6], zoom: 6, bearing: 0, pitch: 0 }
const CARD_WIDTH = 288
const CARD_OFFSET = 8

export interface MapEmbedProps {
  /** Сохранённая карта… */
  mapId?: string | null
  /** …или один слой на подложке по умолчанию. */
  layerId?: string | null
  /** Вид; null — вид карты или охват слоя. */
  camera?: MapCamera | null
  /**
   * Условие тайлов слоя (параметр `f`): фильтры дашборда по датасету слоя,
   * параметры тетради по его полям. Политики строк добавляет сервер.
   */
  filter?: (layer: LayerRecord, dataset: DatasetRecord | undefined) => FilterNode | null
  onCameraChange?: (camera: MapCamera) => void
  /** Кнопки поверх карты рядом с легендой (правка плитки: «запомнить вид»). */
  actions?: ReactNode
  /**
   * Период перечитывания слоёв, мс (TV-режим и дашборд с автообновлением): в записи
   * слоя — версия данных, она входит в адрес тайлов, и новые строки появляются на карте
   * без перезагрузки страницы. null — слои не перечитываются.
   */
  refreshMs?: number | null
  className?: string
}

/**
 * Карта только для просмотра — плитка дашборда и ячейка тетради (ADR-0074):
 * `MapCanvas` без инструментов студии (`staticView`), легенда по кнопке,
 * карточка объекта по щелчку. Живая карта создаётся, только когда плитка на
 * экране и свободен слот WebGL (`useMapSlot`), иначе — заглушка. Права — как в
 * студии: карта или слой по `authorize(view)`, данные — с политиками смотрящего.
 */
export function MapEmbed({
  mapId = null,
  layerId = null,
  camera = null,
  filter,
  onCameraChange,
  actions,
  refreshMs = null,
  className,
}: MapEmbedProps) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const theme = useMapTheme(root)
  const slot = useMapSlot(root)
  const [picked, setPicked] = useState<{
    layerId: string
    rowId: string
    point: [number, number]
  } | null>(null)
  const [fit, setFit] = useState<{ bbox: Bbox; key: number } | null>(null)

  const mapRecord = useQuery({ ...mapQuery(mapId ?? ''), enabled: Boolean(mapId), retry: false })
  const polling = refreshMs ? { refetchInterval: refreshMs, refetchIntervalInBackground: true } : {}
  const single = useQuery({
    ...layerQuery(layerId ?? ''),
    enabled: Boolean(layerId),
    retry: false,
    ...polling,
  })
  const spec = mapRecord.data?.spec ?? null
  const entries: MapLayerEntry[] = mapId
    ? (spec?.layers ?? [])
    : layerId
      ? [{ layerId, visible: true, opacity: 1, group: null }]
      : []
  const layerQueries = useQueries({
    queries: mapId
      ? entries.map((entry) => ({ ...layerQuery(entry.layerId), retry: false, ...polling }))
      : [],
  })
  const records: Array<LayerRecord | null> = mapId
    ? layerQueries.map((query) => query.data ?? null)
    : [single.data ?? null]
  const drawn = entries.flatMap((entry, index) => {
    const layer = records[index]
    return layer ? [{ layer, visible: entry.visible, opacity: entry.opacity }] : []
  })
  const datasets = useQueries({
    queries: drawn.map((entry) => ({ ...datasetQuery(entry.layer.datasetId), retry: false })),
  })
  const filters: Record<string, FilterNode> = {}
  drawn.forEach((entry, index) => {
    const condition = filter?.(entry.layer, datasets[index]?.data)
    if (condition) filters[entry.layer.id] = condition
  })
  const time = spec?.time ? `${spec.time.from}/${spec.time.to}` : null
  const rendered = useRenderedLayers(drawn, theme, { filters, time })
  const basemap = useBasemapStyle(spec?.basemapId ?? null, theme?.mode ?? 'light')

  // Слой без своего вида — к охвату его данных
  const extent = !mapId && !camera ? (single.data?.extent ?? null) : null
  const extentKey = extent?.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: охват — по значению
  useEffect(() => {
    if (extent) setFit({ bbox: extent, key: 0 })
  }, [extentKey, slot.live])

  const failed = mapId ? mapRecord.error : single.error
  if (failed) return <NoAccessState className={cn('h-full', className)} />
  const loading = mapId ? mapRecord.isLoading : single.isLoading
  const view = camera ?? spec?.camera ?? DEFAULT_CAMERA
  const noData = drawn.length > 0 && drawn.every((entry) => !entry.layer.dataAccess)
  const legends = drawn.flatMap(({ layer, visible }) => {
    const legend = visible ? rendered.legends.get(layer.id) : undefined
    return legend?.show ? [{ layer, legend }] : []
  })
  const pickedLayer = picked ? drawn.find((entry) => entry.layer.id === picked.layerId) : undefined
  const objectId = mapId ?? layerId
  const title = mapRecord.data?.name ?? single.data?.name ?? ''

  const onFeatureClick = (event: MapClickEvent) => {
    const hit = event.features[0]
    if (!hit || hit.id === null || Number(hit.properties.point_count ?? 1) > 1) {
      setPicked(null)
      return
    }
    setPicked({
      layerId: hit.source.replace(/^layer-/, ''),
      rowId: String(hit.id),
      point: event.point,
    })
  }

  return (
    <div
      ref={setRoot}
      className={cn('relative h-full min-h-[160px] w-full overflow-hidden', className)}
    >
      {loading ? (
        <Skeleton className="h-full w-full" />
      ) : slot.live ? (
        <MapCanvas
          className="h-full w-full"
          basemapStyle={basemap.style}
          prepare={registerPmtilesProtocol}
          sources={rendered.sources}
          layers={rendered.layers}
          images={rendered.images}
          camera={view}
          fitBounds={fit}
          onCameraChange={onCameraChange}
          interactiveLayerIds={rendered.interactive}
          onFeatureClick={onFeatureClick}
          selection={
            picked
              ? [
                  {
                    source: layerSourceId(picked.layerId),
                    sourceLayer: 'layer',
                    id: Number(picked.rowId),
                  },
                ]
              : []
          }
          staticView
          aria-label={title || t('gis.embed.map')}
        >
          <div className="absolute left-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 shadow-sm">
            {legends.length > 0 ? (
              <Popover>
                <PopoverTrigger asChild>
                  <IconButton label={t('gis.embed.legend')} size="sm">
                    <List className="size-3.5" aria-hidden />
                  </IconButton>
                </PopoverTrigger>
                <PopoverContent align="start" className="max-h-80 w-64 overflow-auto">
                  <div className="flex flex-col gap-3">
                    {legends.map(({ layer, legend }) => (
                      <div key={layer.id} className="flex flex-col gap-1.5">
                        <p className="truncate text-xs font-semibold text-fg">{layer.name}</p>
                        <MapLegend legend={legend} renderIcon={renderMapIcon} />
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
            {objectId ? (
              <IconButton
                label={t(mapId ? 'gis.embed.openMap' : 'gis.embed.openLayer')}
                size="sm"
                onClick={() =>
                  openTab({
                    kind: 'object',
                    objectId,
                    objectType: mapId ? 'map' : 'layer',
                    title: title || t(mapId ? 'objects.types.map' : 'objects.types.layer'),
                    mode: 'permanent',
                  })
                }
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </IconButton>
            ) : null}
            {actions}
          </div>
          {noData ? (
            <div className="pointer-events-none absolute inset-x-2 bottom-8 z-10 flex justify-center">
              <Callout tone="info">{t('gis.map.noDataAccess')}</Callout>
            </div>
          ) : null}
          {picked && pickedLayer ? (
            <div
              className="absolute z-20"
              style={{
                left: `clamp(${CARD_OFFSET}px, ${picked.point[0] + CARD_OFFSET}px, calc(100% - ${CARD_WIDTH + CARD_OFFSET}px))`,
                top: `clamp(${CARD_OFFSET}px, ${picked.point[1] + CARD_OFFSET}px, calc(100% - 200px))`,
              }}
            >
              <FeatureCard
                key={`${picked.layerId}:${picked.rowId}`}
                layer={pickedLayer.layer}
                rowId={picked.rowId}
                onClose={() => setPicked(null)}
              />
            </div>
          ) : null}
        </MapCanvas>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-2 p-3 text-center">
          <MapIcon className="size-6 text-fg-muted" aria-hidden />
          <p className="text-xs text-fg-muted">
            {slot.visible ? t('gis.embed.busy') : t('gis.embed.placeholder')}
          </p>
          {slot.visible ? (
            <Button size="sm" variant="secondary" onClick={slot.promote}>
              {t('gis.embed.show')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
}
