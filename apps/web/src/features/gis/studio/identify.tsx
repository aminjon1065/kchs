import type { LayerRecord, QueryResult, ReverseGeocodeResponse } from '@kchs/contracts'
import { Button, IconButton, Skeleton } from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ChevronLeft, Info, X, ZoomIn } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { FeatureCard } from '../feature-card.js'
import { type FeatureRef, useStudio } from './context.js'
import { formatDecimal } from './coordinates.js'
import { isCluster, layerIdOfSource, pickableLayerIds } from './map-features.js'

/** Допуск щелчка вокруг точки, px: тонкие линии и мелкие точки. */
const TOLERANCE = 5
/** Объектов одного слоя в списке — дальше «и ещё N». */
const PER_LAYER = 20
/** Ширина списка и карточки объекта (`w-72`), px. */
const PANEL_WIDTH = 288

const TEMPLATE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g

/** Подпись объекта из полей тайла: заголовок карточки, поле подписи, первое текстовое поле. */
export function featureLabel(
  layer: Pick<LayerRecord, 'style'>,
  properties: Record<string, unknown>,
): string | null {
  const text = (value: unknown) =>
    value === null || value === undefined || value === '' ? null : String(value)
  const title = layer.style.popup?.title
  if (title) {
    let missing = false
    const filled = title.replace(TEMPLATE, (_match, key: string) => {
      const value = text(properties[key])
      if (value === null) missing = true
      return value ?? ''
    })
    if (!missing && filled.trim()) return filled.trim()
  }
  const labelField = layer.style.label?.field
  if (labelField && text(properties[labelField])) return text(properties[labelField])
  // Служебные поля (`_id`, `_ver`, `point_count`) — не подпись
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith('_') || key === 'point_count') continue
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/**
 * Подписи объектов, которых нет в тайле (поля карточки не входят в тайл):
 * строки слоя по `_id` с политиками смотрящего, подпись — как у карточки.
 */
function useRowLabels(groups: readonly Group[]): ReadonlyMap<string, string> {
  const queries = useQueries({
    queries: groups.map((group) => {
      const ids = group.items.filter((item) => item.label === null).map((item) => item.rowId)
      return {
        queryKey: ['identify', group.layer.id, group.layer.datasetVersion, ids],
        queryFn: async () => {
          const result = await http.post<QueryResult>(
            `/datasets/${group.layer.datasetId}/rows/query`,
            {
              where: { field: '_id', op: 'in', value: ids.map(Number) },
              limit: ids.length,
              count: false,
            },
          )
          const names = result.fields.map((field) => field.name)
          const idIndex = names.indexOf('_id')
          return result.rows.map((row) => {
            const values = Object.fromEntries(names.map((name, index) => [name, row[index]]))
            return [String(row[idIndex]), featureLabel(group.layer, values)] as const
          })
        },
        enabled: ids.length > 0,
        staleTime: 30_000,
        retry: false,
      }
    }),
  })
  const out = new Map<string, string>()
  groups.forEach((group, index) => {
    for (const [rowId, label] of queries[index]?.data ?? []) {
      if (label) out.set(`${group.layer.id}:${rowId}`, label)
    }
  })
  return out
}

interface Group {
  layer: LayerRecord
  items: Array<FeatureRef & { label: string | null }>
  more: number
  clusters: number
}

interface Result {
  point: [number, number]
  lngLat: [number, number]
  groups: Group[]
}

const NO_GROUPS: Group[] = []

/**
 * Идентификация (P2-E02 S02): щелчок — все объекты всех видимых слоёв в точке
 * списком по слоям, территория точки (обратный геокодер) и переход к карточке
 * объекта. Скопление — приближение к нему.
 */
export function IdentifyTool() {
  const t = useT()
  const studio = useStudio()
  const { map } = studio
  const [result, setResult] = useState<Result | null>(null)
  const [opened, setOpened] = useState<FeatureRef | null>(null)
  const latest = useRef(studio)
  latest.current = studio
  const active = studio.tool === 'identify'
  const labels = useRowLabels(result?.groups ?? NO_GROUPS)

  useEffect(() => {
    if (!map || !active) return
    const container = map.getCanvasContainer()
    container.style.cursor = 'help'
    const onClick = (event: {
      point: { x: number; y: number }
      lngLat: { lng: number; lat: number }
    }) => {
      const { x, y } = event.point
      const layers = pickableLayerIds(map)
      const hits = layers.length
        ? map.queryRenderedFeatures(
            [
              [x - TOLERANCE, y - TOLERANCE],
              [x + TOLERANCE, y + TOLERANCE],
            ],
            { layers },
          )
        : []
      const groups = new Map<string, Group>()
      const seen = new Set<string>()
      for (const hit of hits) {
        const layerId = layerIdOfSource(hit.source)
        const layer = layerId ? latest.current.layerById.get(layerId) : undefined
        if (!layerId || !layer) continue
        const group = groups.get(layerId) ?? { layer, items: [], more: 0, clusters: 0 }
        groups.set(layerId, group)
        if (isCluster(hit)) {
          group.clusters += Number(hit.properties?.point_count ?? 0)
          continue
        }
        if (hit.id === undefined || hit.id === null) continue
        const key = `${layerId}:${hit.id}`
        if (seen.has(key)) continue
        seen.add(key)
        if (group.items.length >= PER_LAYER) {
          group.more += 1
          continue
        }
        group.items.push({
          layerId,
          rowId: String(hit.id),
          label: featureLabel(layer, hit.properties ?? {}),
        })
      }
      setOpened(null)
      setResult({
        point: [x, y],
        lngLat: [event.lngLat.lng, event.lngLat.lat],
        groups: [...groups.values()],
      })
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      container.style.cursor = ''
    }
  }, [map, active])

  // Инструмент выключен — список закрывается
  useEffect(() => {
    if (!active) {
      setResult(null)
      setOpened(null)
    }
  }, [active])

  if (!map || !result) return null
  const openedLayer = opened ? studio.layerById.get(opened.layerId) : undefined
  const total = result.groups.reduce((sum, group) => sum + group.items.length + group.more, 0)
  const [x, y] = result.point

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc закрывает список — удобство для клавиатуры
    <div
      className="absolute z-20 font-sans"
      style={{
        left: `clamp(12px, ${x + 12}px, calc(100% - ${PANEL_WIDTH + 12}px))`,
        top: `clamp(12px, ${y + 12}px, calc(100% - 320px))`,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setResult(null)
      }}
    >
      {opened && openedLayer ? (
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            icon={<ChevronLeft className="size-3.5" />}
            onClick={() => setOpened(null)}
          >
            {t('gis.identify.back')}
          </Button>
          <FeatureCard
            key={`${opened.layerId}:${opened.rowId}`}
            layer={openedLayer}
            rowId={opened.rowId}
            onClose={() => setResult(null)}
          />
        </div>
      ) : (
        <section
          aria-label={t('gis.identify.title')}
          className="flex max-h-[min(420px,calc(100vh-12rem))] w-72 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-line bg-surface shadow-md"
        >
          <header className="flex items-start gap-2 border-b border-line px-3 py-2">
            <Info className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-fg">
                {t('gis.identify.found', { count: total })}
              </h3>
              <p className="tabular text-xs text-fg-muted">
                {formatDecimal({ lon: result.lngLat[0], lat: result.lngLat[1] })}
              </p>
              <PlaceChain lon={result.lngLat[0]} lat={result.lngLat[1]} />
            </div>
            <IconButton label={t('common.actions.close')} size="sm" onClick={() => setResult(null)}>
              <X className="size-4" aria-hidden />
            </IconButton>
          </header>
          <div className="min-h-0 overflow-y-auto py-1">
            {result.groups.length === 0 ? (
              <p className="px-3 py-2 text-sm text-fg-muted">{t('gis.identify.nothing')}</p>
            ) : (
              result.groups.map((group) => (
                <div key={group.layer.id} className="py-1">
                  <h4 className="truncate px-3 pb-0.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted">
                    {group.layer.name}
                  </h4>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.rowId}>
                        <button
                          type="button"
                          className="w-full truncate px-3 py-1 text-left text-sm text-fg hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                          onClick={() => {
                            studio.setSelection([{ layerId: item.layerId, rowId: item.rowId }])
                            studio.setActiveLayerId(item.layerId)
                            setOpened({ layerId: item.layerId, rowId: item.rowId })
                          }}
                        >
                          {item.label ??
                            labels.get(`${item.layerId}:${item.rowId}`) ??
                            t('gis.identify.object', { id: item.rowId })}
                        </button>
                      </li>
                    ))}
                    {group.more > 0 ? (
                      <li className="px-3 py-1 text-xs text-fg-muted">
                        {t('gis.identify.more', { count: group.more })}
                      </li>
                    ) : null}
                    {group.clusters > 0 ? (
                      <li>
                        <button
                          type="button"
                          className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-sm text-fg-secondary hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
                          onClick={() => {
                            setResult(null)
                            studio.setCamera({
                              ...studio.camera,
                              center: result.lngLat,
                              zoom: Math.min(22, studio.camera.zoom + 2),
                            })
                          }}
                        >
                          <ZoomIn className="size-3.5 shrink-0" aria-hidden />
                          {t('gis.identify.cluster', { count: group.clusters })}
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ))
            )}
          </div>
        </section>
      )}
    </div>,
    map.getContainer(),
  )
}

/** Территории, содержащие точку: «Хатлонская область › Бохтар». */
function PlaceChain({ lon, lat }: { lon: number; lat: number }) {
  const locale = useAppearance((s) => s.locale)
  const { data, isLoading } = useQuery({
    queryKey: ['geocode', 'reverse', lon.toFixed(5), lat.toFixed(5)],
    queryFn: () =>
      http.get<ReverseGeocodeResponse>('/gis/geocode/reverse', { query: { lon, lat } }),
    staleTime: 10 * 60_000,
    retry: false,
  })
  if (isLoading) return <Skeleton className="mt-1 h-3.5 w-40" />
  const chain = (data?.chain ?? []).filter((item) => item.level !== 'country')
  const nearest = data?.nearest?.territory
  const names = [...chain, ...(nearest ? [nearest] : [])].map(
    (item) => item.name[locale] ?? item.name.ru,
  )
  if (names.length === 0) return null
  return <p className="truncate text-xs text-fg-secondary">{names.join(' › ')}</p>
}
