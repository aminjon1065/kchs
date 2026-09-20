import type { MapServiceEntry, ServiceLayerRecord } from '@kchs/contracts'
import type { MapLayerSpecification, MapSourceSpecification } from '@kchs/ui'
import { useMemo } from 'react'
import { serviceFeaturesUrl, serviceTileUrl } from './service-layers.js'

/**
 * Слои-ссылки на внешние ГИС-службы на карте (ADR-0108): растровые рисуются
 * тайлами через прокси, векторные — объектами GeoJSON, тоже через прокси.
 * Рисуются под слоями данных: служба — подложка, а не данные платформы.
 */
export interface ServiceRenderEntry {
  service: ServiceLayerRecord
  visible: boolean
  opacity: number
}

export interface RenderedServices {
  sources: Record<string, MapSourceSpecification>
  layers: MapLayerSpecification[]
}

const RASTER = new Set(['xyz', 'wms', 'wmts'])

export const serviceSourceId = (id: string) => `service-${id}`

export function useServiceLayers(entries: readonly ServiceRenderEntry[]): RenderedServices {
  const key = entries
    .map(
      (entry) => `${entry.service.id}:${entry.service.version}:${entry.visible}:${entry.opacity}`,
    )
    .join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: состав слоёв описан ключом
  return useMemo(() => {
    const sources: Record<string, MapSourceSpecification> = {}
    const layers: MapLayerSpecification[] = []
    for (const entry of entries) {
      if (!entry.visible) continue
      const { service } = entry
      const source = serviceSourceId(service.id)
      if (RASTER.has(service.kind)) {
        sources[source] = {
          type: 'raster',
          tiles: [serviceTileUrl(service)],
          tileSize: service.tileSize,
          minzoom: service.minZoom,
          maxzoom: service.maxZoom,
          ...(service.attribution ? { attribution: service.attribution } : {}),
        } as MapSourceSpecification
        layers.push({
          id: `${source}-raster`,
          type: 'raster',
          source,
          paint: { 'raster-opacity': entry.opacity * service.opacity },
        } as MapLayerSpecification)
        continue
      }
      sources[source] = {
        type: 'geojson',
        data: serviceFeaturesUrl(service),
        ...(service.attribution ? { attribution: service.attribution } : {}),
      } as MapSourceSpecification
      const opacity = entry.opacity * service.opacity
      layers.push(
        {
          id: `${source}-fill`,
          type: 'fill',
          source,
          filter: ['==', ['geometry-type'], 'Polygon'],
          paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.25 * opacity },
        } as MapLayerSpecification,
        {
          id: `${source}-line`,
          type: 'line',
          source,
          filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
          paint: { 'line-color': '#6366f1', 'line-width': 1.5, 'line-opacity': opacity },
        } as MapLayerSpecification,
        {
          id: `${source}-point`,
          type: 'circle',
          source,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-color': '#6366f1',
            'circle-radius': 4,
            'circle-opacity': opacity,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
          },
        } as MapLayerSpecification,
      )
    }
    return { sources, layers }
  }, [key])
}

/** Записи карты → слои к отрисовке по реестру служб. */
export function serviceEntries(
  spec: readonly MapServiceEntry[],
  services: readonly ServiceLayerRecord[],
): ServiceRenderEntry[] {
  const byId = new Map(services.map((service) => [service.id, service]))
  return spec.flatMap((entry) => {
    const service = byId.get(entry.serviceId)
    return service ? [{ service, visible: entry.visible, opacity: entry.opacity }] : []
  })
}
