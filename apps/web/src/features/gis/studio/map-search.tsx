import type {
  Bbox,
  GeocodeResponse,
  LangText,
  LayerRecord,
  QueryResult,
  TerritoryFeature,
} from '@kchs/contracts'
import {
  cn,
  IconButton,
  type MapLayerSpecification,
  SearchInput,
  Spinner,
  Tooltip,
  useDebouncedValue,
  useMapTheme,
} from '@kchs/ui'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Crosshair, MapPin, Search, Shapes } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { useStudio } from './context.js'
import { type CoordinateCandidate, formatHemispheres, parseCoordinates } from './coordinates.js'
import { atLeast, geometryBounds } from './geometry.js'
import { featureLabel } from './identify.js'
import { allOf, layerRowConditions } from './map-features.js'
import { EMPTY_OVERLAY, type OverlayData, useToolOverlay } from './overlay.js'

/** Слоёв, в которых ищутся объекты, и объектов на слой. */
const OBJECT_LAYERS = 6
const OBJECTS_PER_LAYER = 5
/** Мест из геокодера. */
const PLACES = 6
/** Зум перехода к точке (координаты, населённый пункт без границы). */
const POINT_ZOOM = 13
/** Уже этой ширины карты поле поиска свёрнуто в кнопку, px. */
const COMPACT_WIDTH = 960

const POINTS = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]]
const POLYGONS = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]

type Option =
  | { kind: 'coords'; key: string; candidate: CoordinateCandidate }
  | {
      kind: 'place'
      key: string
      title: string
      detail: string
      id: string
      center: [number, number]
      bbox: Bbox | null
    }
  | {
      kind: 'object'
      key: string
      title: string
      detail: string
      layerId: string
      rowId: string
      geometry: unknown
    }

/** Строки поиска по объектам слоя: видимые поля, геометрия и подпись. */
async function searchLayer(
  layer: LayerRecord,
  search: string,
  where: ReturnType<typeof allOf>,
): Promise<Array<{ rowId: string; values: Record<string, unknown> }>> {
  const result = await http.post<QueryResult>(`/datasets/${layer.datasetId}/rows/query`, {
    search,
    limit: OBJECTS_PER_LAYER,
    count: false,
    ...(where ? { where } : {}),
  })
  const names = result.fields.map((field) => field.name)
  const idIndex = names.indexOf('_id')
  return result.rows.map((row) => ({
    rowId: String(row[idIndex]),
    values: Object.fromEntries(names.map((name, index) => [name, row[index]])),
  }))
}

/**
 * Поиск на карте (P2-E02 S02, 03-screens.md §10): координаты (десятичные и
 * градусы-минуты-секунды), адрес и территория (внутренний геокодер, ADR-0067)
 * и объекты видимых слоёв (быстрый поиск строк с политиками смотрящего).
 * Переход к результату; у территории — её граница, у точки — метка.
 */
export function MapSearch() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const studio = useStudio()
  const { map } = studio
  const theme = useMapTheme(map?.getContainer() ?? null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [found, setFound] = useState<OverlayData>(EMPTY_OVERLAY)
  const text = useDebouncedValue(query.trim(), 250)
  const input = useRef<HTMLInputElement>(null)
  // Узкая карта: поле свёрнуто в кнопку, чтобы не закрывать тулбар инструментов
  const [compact, setCompact] = useState(false)
  const [unfolded, setUnfolded] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!map) return
    const element = map.getContainer()
    const measure = () => setCompact(element.clientWidth < COMPACT_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // «/» на карте — к поиску (04-interaction-patterns.md §8)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      setUnfolded(true)
      input.current?.focus()
    }
    element.addEventListener('keydown', onKey)
    return () => {
      observer.disconnect()
      element.removeEventListener('keydown', onKey)
    }
  }, [map])

  // Раскрытое по кнопке или «/» поле — сразу с фокусом
  useEffect(() => {
    if (unfolded) input.current?.focus()
  }, [unfolded])

  const coords = useMemo(() => parseCoordinates(text), [text])
  const searching = text.length >= 2
  const places = useQuery({
    queryKey: ['geocode', text, PLACES],
    queryFn: () => http.get<GeocodeResponse>('/gis/geocode', { query: { q: text, limit: PLACES } }),
    enabled: searching && coords.length === 0,
    staleTime: 60_000,
    retry: false,
  })
  const layers = studio.layers
    .filter((item) => item.entry.visible && item.layer?.dataAccess)
    .flatMap((item) => (item.layer ? [item.layer] : []))
    .slice(0, OBJECT_LAYERS)
  const objects = useQueries({
    queries: layers.map((layer) => {
      const where = allOf(
        layerRowConditions(layer, {
          filter: studio.layerFilters[layer.id] ?? null,
          time: studio.spec.time,
        }),
      )
      return {
        queryKey: ['map-search', layer.id, layer.datasetVersion, text, where ?? null],
        queryFn: () => searchLayer(layer, text, where),
        enabled: searching && coords.length === 0,
        staleTime: 30_000,
        retry: false,
      }
    }),
  })

  const name = (value: LangText) => value[locale] ?? value.ru
  const hemispheres = {
    n: t('gis.coords.n'),
    s: t('gis.coords.s'),
    e: t('gis.coords.e'),
    w: t('gis.coords.w'),
  }
  const options: Option[] = []
  const groups: Array<{ id: string; label: string; start: number; count: number }> = []
  const group = (id: string, label: string, items: Option[]) => {
    if (items.length === 0) return
    groups.push({ id, label, start: options.length, count: items.length })
    options.push(...items)
  }
  group(
    'coords',
    t('gis.search.coordinates'),
    coords.map((candidate) => ({
      kind: 'coords' as const,
      key: `coords:${candidate.order}`,
      candidate,
    })),
  )
  if (searching && coords.length === 0) {
    group(
      'places',
      t('gis.search.places'),
      (places.data?.items ?? []).map((item) => ({
        kind: 'place' as const,
        key: `place:${item.territory.id}`,
        title: name(item.territory.name),
        detail: [
          t(`gis.territories.levels.${item.territory.level}`),
          ...[...item.path]
            .reverse()
            .filter((parent) => parent.level !== 'country')
            .map((parent) => name(parent.name)),
        ].join(' · '),
        id: item.territory.id,
        center: [item.center.lon, item.center.lat] as [number, number],
        bbox: item.bbox,
      })),
    )
    layers.forEach((layer, index) => {
      group(
        `layer:${layer.id}`,
        layer.name,
        (objects[index]?.data ?? []).map((row) => ({
          kind: 'object' as const,
          key: `object:${layer.id}:${row.rowId}`,
          title: featureLabel(layer, row.values) ?? t('gis.identify.object', { id: row.rowId }),
          detail: layer.name,
          layerId: layer.id,
          rowId: row.rowId,
          geometry: row.values[layer.geometryField],
        })),
      )
    })
  }
  const loading =
    searching &&
    coords.length === 0 &&
    (places.isFetching || objects.some((item) => item.isFetching))
  const expanded = open && searching && (options.length > 0 || !loading)
  const current = Math.min(active, Math.max(0, options.length - 1))
  const optionId = (index: number) => `${listId}-${index}`

  useToolOverlay(
    map,
    'search',
    found,
    (source) => {
      if (!theme) return []
      const accent = theme.tokens.accent
      return [
        {
          id: 'search-fill',
          type: 'fill',
          source,
          filter: POLYGONS,
          paint: { 'fill-color': accent, 'fill-opacity': 0.06 },
        },
        {
          id: 'search-outline',
          type: 'line',
          source,
          filter: ['!', POINTS],
          layout: { 'line-join': 'round' },
          paint: { 'line-color': accent, 'line-width': 2.5, 'line-opacity': 0.9 },
        },
        {
          id: 'search-point',
          type: 'circle',
          source,
          filter: POINTS,
          paint: {
            'circle-radius': 7,
            'circle-color': accent,
            'circle-stroke-color': theme.surface,
            'circle-stroke-width': 2.5,
          },
        },
      ] as MapLayerSpecification[]
    },
    theme?.mode ?? '',
  )

  const pointOverlay = (lon: number, lat: number): OverlayData => ({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } },
    ],
  })

  const choose = (option: Option) => {
    setOpen(false)
    // На узкой карте поле уступает место тулбару: результат уже на карте
    if (compact) input.current?.blur()
    switch (option.kind) {
      case 'coords': {
        const { lon, lat } = option.candidate
        studio.setCamera({
          ...studio.camera,
          center: [lon, lat],
          zoom: Math.max(studio.camera.zoom, POINT_ZOOM),
        })
        setFound(pointOverlay(lon, lat))
        return
      }
      case 'place': {
        if (option.bbox) studio.fitBounds(option.bbox)
        else {
          studio.setCamera({ ...studio.camera, center: option.center, zoom: POINT_ZOOM })
        }
        setFound(pointOverlay(option.center[0], option.center[1]))
        if (option.bbox) {
          // Граница единицы — упрощённая под масштаб, взамен метки центра
          void http
            .get<TerritoryFeature>(`/gis/territories/${option.id}/geometry`, {
              query: { zoom: 10 },
            })
            .then((feature) =>
              setFound({
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: feature.geometry as OverlayData['features'][number]['geometry'],
                  },
                ],
              }),
            )
            .catch(() => undefined)
        }
        return
      }
      case 'object': {
        const bounds = geometryBounds(option.geometry)
        if (bounds) studio.fitBounds(atLeast(bounds))
        studio.setSelection([{ layerId: option.layerId, rowId: option.rowId }])
        studio.setActiveLayerId(option.layerId)
        setFound(EMPTY_OVERLAY)
        return
      }
    }
  }

  if (!map) return null
  const icon: Record<Option['kind'], ReactNode> = {
    coords: <Crosshair className="size-4 shrink-0 text-fg-muted" aria-hidden />,
    place: <MapPin className="size-4 shrink-0 text-fg-muted" aria-hidden />,
    object: <Shapes className="size-4 shrink-0 text-fg-muted" aria-hidden />,
  }
  const collapsed = compact && !unfolded && !focused

  return createPortal(
    <div
      className={cn(
        'absolute left-2 top-2 z-20 max-w-[calc(100%-4rem)] font-sans',
        collapsed ? 'w-auto' : 'w-72',
      )}
    >
      {collapsed ? (
        <Tooltip content={t('gis.search.label')} shortcut="/">
          <IconButton
            label={t('gis.search.label')}
            variant="secondary"
            size="lg"
            active={query.length > 0}
            className="shadow-sm"
            onClick={() => setUnfolded(true)}
          >
            <Search className="size-4" aria-hidden />
          </IconButton>
        </Tooltip>
      ) : (
        <SearchInput
          ref={input}
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            setActive(0)
            setOpen(true)
            if (!value) setFound(EMPTY_OVERLAY)
          }}
          onClear={() => setFound(EMPTY_OVERLAY)}
          onFocus={() => {
            setOpen(true)
            setFocused(true)
          }}
          onBlur={() => {
            setOpen(false)
            setFocused(false)
            setUnfolded(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && options.length > 0) {
              event.preventDefault()
              setOpen(true)
              setActive((current + 1) % options.length)
            } else if (event.key === 'ArrowUp' && options.length > 0) {
              event.preventDefault()
              setActive((current - 1 + options.length) % options.length)
            } else if (event.key === 'Enter' && expanded && options[current]) {
              event.preventDefault()
              choose(options[current] as Option)
            } else if (event.key === 'Escape') {
              if (expanded) setOpen(false)
              else {
                setQuery('')
                setFound(EMPTY_OVERLAY)
              }
            }
          }}
          placeholder={t('gis.search.placeholder')}
          aria-label={t('gis.search.label')}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && options[current] ? optionId(current) : undefined}
          className="shadow-sm"
        />
      )}
      {expanded && options.length === 0 ? (
        <p
          id={listId}
          className="mt-1 rounded-md border border-line bg-overlay px-3 py-2 text-sm text-fg-muted shadow-md"
        >
          {loading ? <Spinner className="size-4" /> : t('gis.search.nothing')}
        </p>
      ) : null}
      {expanded && options.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('gis.search.results')}
          className="mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-overlay py-1 shadow-md"
        >
          {groups.map((item) => (
            // biome-ignore lint/a11y/useSemanticElements: группа вариантов списка (шаблон ARIA listbox), а не поля формы
            <div key={item.id} role="group" aria-label={item.label}>
              <p
                aria-hidden
                className="truncate px-3 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-muted"
              >
                {item.label}
              </p>
              {options.slice(item.start, item.start + item.count).map((option, offset) => {
                const index = item.start + offset
                const selected = index === current
                const title =
                  option.kind === 'coords'
                    ? formatHemispheres(option.candidate, hemispheres)
                    : option.title
                const detail =
                  option.kind === 'coords'
                    ? t(`gis.search.order.${option.candidate.order}`)
                    : option.detail
                return (
                  <div
                    key={option.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    // Выбор мышью — до потери фокуса полем
                    onMouseDown={(event) => {
                      event.preventDefault()
                      choose(option)
                    }}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                      selected && 'bg-accent-subtle',
                    )}
                  >
                    {icon[option.kind]}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{title}</span>
                      <span className="block truncate text-xs text-fg-muted">{detail}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          {loading ? (
            <p aria-hidden className="flex items-center gap-2 px-3 py-1.5 text-xs text-fg-muted">
              <Spinner className="size-3.5" />
              {t('gis.search.loading')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>,
    map.getContainer(),
  )
}
