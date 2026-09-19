import { BASEMAP_FONTS, type BasemapTheme, type Locale } from '@kchs/contracts'
import { PALETTES, type Palette } from './basemap-palette.js'

/**
 * Стиль MapLibre (спецификация v8) базовой карты (07-gis-engine.md §5, ADR-0066):
 * схема OpenMapTiles для векторной подложки PMTiles, растровый источник через
 * прокси API или только фон. Адреса — абсолютные, их собирает сервис.
 */

type Json = Record<string, unknown>
type Layer = Json & { id: string; type: string }

export interface StyleUrls {
  /** Шаблон `…/gis/glyphs/{fontstack}/{range}.pbf`. */
  glyphs: string
  /** База спрайта темы без расширения: MapLibre добавит `.json`, `.png`, `@2x`. */
  sprite: string
}

export type StyleContent =
  | { kind: 'none' }
  | {
      kind: 'vector'
      /** Адрес архива PMTiles через API (протокол `pmtiles://` у клиента). */
      archive: string
      attribution: string | null
      /** Центр сборки: [долгота, широта, масштаб]. */
      center: [number, number, number] | null
    }
  | {
      kind: 'raster'
      tiles: string
      tileSize: number
      minZoom: number
      maxZoom: number
      attribution: string | null
      bounds: [number, number, number, number] | null
    }

export interface StyleOptions {
  id: string
  name: string
  theme: BasemapTheme
  lang: Locale
  urls: StyleUrls
  content: StyleContent
}

const SOURCE = 'openmaptiles'
const REGULAR = [BASEMAP_FONTS.regular]
const BOLD = [BASEMAP_FONTS.bold]
const ITALIC = [BASEMAP_FONTS.italic]
const MAJOR_ROADS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']

/** Название на языке интерфейса, затем русское (для таджикского) и исходное. */
function nameExpression(lang: Locale): unknown[] {
  if (lang === 'en') {
    return ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]
  }
  if (lang === 'tg') return ['coalesce', ['get', 'name:tg'], ['get', 'name'], ['get', 'name:ru']]
  return ['coalesce', ['get', 'name:ru'], ['get', 'name']]
}

const byZoom = (stops: Array<[number, unknown]>, base = 1): unknown[] => [
  'interpolate',
  base === 1 ? ['linear'] : ['exponential', base],
  ['zoom'],
  ...stops.flat(),
]

const halo = (palette: Palette) => ({
  'text-halo-color': palette.halo,
  'text-halo-width': 1.25,
  'text-halo-blur': 0.25,
})

/** Ширина крупной дороги по классу: минимальный масштаб класса задаёт нулевая ширина. */
function majorRoadWidth(extra: number): unknown[] {
  const at = (motorway: number, primary: number, secondary: number, tertiary: number) => [
    'match',
    ['get', 'class'],
    ['motorway', 'trunk'],
    motorway > 0 ? motorway + extra : 0,
    'primary',
    primary > 0 ? primary + extra : 0,
    'secondary',
    secondary > 0 ? secondary + extra : 0,
    tertiary > 0 ? tertiary + extra : 0,
  ]
  return byZoom(
    [
      [5, at(0.6, 0, 0, 0)],
      [7, at(1, 0.6, 0, 0)],
      [10, at(2, 1.6, 1.2, 0.8)],
      [14, at(5, 4, 3.5, 3)],
      [18, at(18, 16, 14, 12)],
    ],
    1.5,
  )
}

function vectorLayers(palette: Palette, lang: Locale): Layer[] {
  const name = nameExpression(lang)
  const layers: Layer[] = []
  const fromSource = (id: string, type: string, sourceLayer: string, rest: Json): Layer => ({
    id,
    type,
    source: SOURCE,
    'source-layer': sourceLayer,
    ...rest,
  })

  // ── Земля: растительность, ледники Памира, скалы и пески ─────────────────
  if (palette.land) {
    const land = palette.land
    layers.push(
      fromSource('landcover', 'fill', 'landcover', {
        filter: [
          'match',
          ['get', 'class'],
          ['wood', 'grass', 'wetland', 'ice', 'rock', 'sand'],
          true,
          false,
        ],
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            'ice',
            land.ice,
            ['rock', 'sand'],
            land.bare,
            land.vegetation,
          ],
          'fill-opacity': land.opacity,
          'fill-antialias': false,
        },
      }),
      fromSource('park', 'fill', 'park', {
        minzoom: 8,
        paint: { 'fill-color': land.vegetation, 'fill-opacity': 0.35, 'fill-antialias': false },
      }),
    )
  }
  if (palette.residential) {
    layers.push(
      fromSource('landuse-residential', 'fill', 'landuse', {
        minzoom: 10,
        filter: [
          'match',
          ['get', 'class'],
          ['residential', 'suburb', 'quarter', 'neighbourhood'],
          true,
          false,
        ],
        paint: {
          'fill-color': palette.residential,
          'fill-opacity': byZoom([
            [10, 0.4],
            [14, 0.8],
          ]),
        },
      }),
    )
  }

  // ── Вода ─────────────────────────────────────────────────────────────────
  layers.push(
    fromSource('water', 'fill', 'water', {
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': palette.water },
    }),
    fromSource('waterway-river', 'line', 'waterway', {
      filter: ['match', ['get', 'class'], ['river', 'canal'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.waterway,
        'line-width': byZoom(
          [
            [6, 0.6],
            [10, 1.2],
            [14, 3],
          ],
          1.3,
        ),
      },
    }),
    fromSource('waterway-stream', 'line', 'waterway', {
      minzoom: 12,
      filter: ['match', ['get', 'class'], ['river', 'canal'], false, true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.waterway,
        'line-width': byZoom([
          [12, 0.5],
          [16, 1.5],
        ]),
      },
    }),
  )

  if (palette.building) {
    layers.push(
      fromSource('building', 'fill', 'building', {
        minzoom: 13,
        paint: {
          'fill-color': palette.building,
          'fill-opacity': byZoom([
            [13, 0.5],
            [15, 1],
          ]),
        },
      }),
    )
  }

  // ── Дороги ───────────────────────────────────────────────────────────────
  const lineLayout = { 'line-cap': 'round', 'line-join': 'round' }
  layers.push(
    fromSource('road-minor', 'line', 'transportation', {
      minzoom: 12,
      filter: ['match', ['get', 'class'], ['minor', 'service'], true, false],
      layout: lineLayout,
      paint: {
        'line-color': palette.roadMinor,
        'line-width': byZoom(
          [
            [12, 0.5],
            [14, 2],
            [18, 10],
          ],
          1.5,
        ),
      },
    }),
    fromSource('road-track', 'line', 'transportation', {
      minzoom: 14,
      filter: ['==', ['get', 'class'], 'track'],
      layout: lineLayout,
      paint: {
        'line-color': palette.roadMinor,
        'line-width': byZoom([
          [14, 0.8],
          [18, 2],
        ]),
        'line-dasharray': [2, 1.5],
      },
    }),
  )
  const majorFilter = ['match', ['get', 'class'], MAJOR_ROADS, true, false]
  if (palette.roadCasing) {
    layers.push(
      fromSource('road-major-casing', 'line', 'transportation', {
        minzoom: 5,
        filter: majorFilter,
        layout: lineLayout,
        paint: { 'line-color': palette.roadCasing, 'line-width': majorRoadWidth(1) },
      }),
    )
  }
  layers.push(
    fromSource('road-major', 'line', 'transportation', {
      minzoom: 5,
      filter: majorFilter,
      layout: lineLayout,
      paint: { 'line-color': palette.roadMajor, 'line-width': majorRoadWidth(0) },
    }),
    fromSource('rail', 'line', 'transportation', {
      minzoom: 10,
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: {
        'line-color': palette.rail,
        'line-width': byZoom([
          [10, 0.8],
          [16, 2],
        ]),
        'line-dasharray': [3, 2],
      },
    }),
  )

  // ── Границы: области пунктиром, страны сплошной, спорные — штрихом ────────
  const onLand = ['!=', ['get', 'maritime'], 1]
  layers.push(
    fromSource('boundary-region', 'line', 'boundary', {
      minzoom: 4,
      filter: ['all', ['==', ['get', 'admin_level'], 4], onLand],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': palette.boundary,
        'line-opacity': 0.35,
        'line-width': byZoom([
          [4, 0.6],
          [12, 1.4],
        ]),
        'line-dasharray': [3, 2],
      },
    }),
    fromSource('boundary-country', 'line', 'boundary', {
      filter: ['all', ['==', ['get', 'admin_level'], 2], onLand, ['!=', ['get', 'disputed'], 1]],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': palette.boundary,
        'line-opacity': 0.6,
        'line-width': byZoom([
          [2, 0.8],
          [10, 2],
        ]),
      },
    }),
    fromSource('boundary-disputed', 'line', 'boundary', {
      filter: ['all', ['==', ['get', 'admin_level'], 2], onLand, ['==', ['get', 'disputed'], 1]],
      paint: {
        'line-color': palette.boundary,
        'line-opacity': 0.6,
        'line-width': byZoom([
          [2, 0.8],
          [10, 2],
        ]),
        'line-dasharray': [2, 2],
      },
    }),
  )

  // ── Подписи: вода, дороги, вершины, населённые пункты, регионы, страны ────
  const hasName = ['has', 'name']
  layers.push(
    fromSource('waterway-label', 'symbol', 'waterway', {
      minzoom: 11,
      filter: ['all', hasName, ['match', ['get', 'class'], ['river', 'canal'], true, false]],
      layout: {
        'symbol-placement': 'line',
        'text-field': name,
        'text-font': ITALIC,
        'text-size': 11,
        'text-letter-spacing': 0.05,
      },
      paint: { 'text-color': palette.labelWater, ...halo(palette) },
    }),
    fromSource('water-label', 'symbol', 'water_name', {
      filter: ['all', hasName, ['==', ['geometry-type'], 'Point']],
      layout: {
        'text-field': name,
        'text-font': ITALIC,
        'text-size': byZoom([
          [8, 11],
          [14, 14],
        ]),
        'text-max-width': 8,
      },
      paint: { 'text-color': palette.labelWater, ...halo(palette) },
    }),
    fromSource('water-label-line', 'symbol', 'water_name', {
      filter: ['all', hasName, ['==', ['geometry-type'], 'LineString']],
      layout: {
        'symbol-placement': 'line',
        'text-field': name,
        'text-font': ITALIC,
        'text-size': 12,
      },
      paint: { 'text-color': palette.labelWater, ...halo(palette) },
    }),
    fromSource('road-label', 'symbol', 'transportation_name', {
      minzoom: 13,
      filter: hasName,
      layout: {
        'symbol-placement': 'line',
        'text-field': name,
        'text-font': REGULAR,
        'text-size': byZoom([
          [13, 10],
          [17, 12],
        ]),
      },
      paint: { 'text-color': palette.labelMuted, ...halo(palette) },
    }),
    fromSource('peak-label', 'symbol', 'mountain_peak', {
      minzoom: 9,
      filter: ['all', hasName, ['match', ['get', 'class'], ['peak', 'volcano'], true, false]],
      layout: {
        'icon-image': 'peak',
        'text-field': [
          'case',
          ['has', 'ele'],
          [
            'format',
            name,
            {},
            '\n',
            {},
            ['concat', ['to-string', ['get', 'ele']], lang === 'en' ? ' m' : ' м'],
            { 'font-scale': 0.85 },
          ],
          name,
        ],
        'text-font': REGULAR,
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.7],
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': palette.labelMuted, ...halo(palette) },
    }),
  )

  const place = (classes: string[]) => ['match', ['get', 'class'], classes, true, false]
  const capital = ['==', ['get', 'capital'], 2]
  const citySize = byZoom([
    [5, 11],
    [10, 15],
    [14, 18],
  ])
  layers.push(
    fromSource('place-suburb', 'symbol', 'place', {
      minzoom: 12,
      filter: ['all', hasName, place(['suburb', 'quarter', 'neighbourhood'])],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': byZoom([
          [12, 10],
          [16, 12],
        ]),
        'text-max-width': 8,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
      },
      paint: { 'text-color': palette.labelMuted, ...halo(palette) },
    }),
    fromSource('place-village', 'symbol', 'place', {
      minzoom: 11,
      filter: ['all', hasName, place(['village', 'hamlet', 'isolated_dwelling'])],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': byZoom([
          [11, 10],
          [15, 13],
        ]),
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': palette.labelMuted, ...halo(palette) },
    }),
    fromSource('place-town', 'symbol', 'place', {
      minzoom: 9,
      filter: ['all', hasName, place(['town'])],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': byZoom([
          [9, 11],
          [14, 15],
        ]),
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': palette.label, ...halo(palette) },
    }),
    // На мелких масштабах город — точка с подписью, крупнее — только подпись
    fromSource('place-city-dot', 'symbol', 'place', {
      minzoom: 5,
      maxzoom: 10,
      filter: ['all', hasName, place(['city']), ['!', capital]],
      layout: {
        'icon-image': 'city',
        'text-field': name,
        'text-font': REGULAR,
        'text-size': citySize,
        'text-max-width': 8,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.6,
        'text-justify': 'auto',
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': palette.labelStrong, ...halo(palette) },
    }),
    fromSource('place-city', 'symbol', 'place', {
      minzoom: 10,
      filter: ['all', hasName, place(['city']), ['!', capital]],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': citySize,
        'text-max-width': 8,
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': palette.labelStrong, ...halo(palette) },
    }),
    fromSource('place-capital', 'symbol', 'place', {
      minzoom: 3,
      filter: ['all', hasName, capital],
      layout: {
        'icon-image': 'capital',
        'text-field': name,
        'text-font': BOLD,
        'text-size': byZoom([
          [3, 12],
          [10, 17],
          [14, 20],
        ]),
        'text-max-width': 8,
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.8,
        'text-justify': 'auto',
      },
      paint: { 'text-color': palette.labelStrong, ...halo(palette) },
    }),
    fromSource('place-state', 'symbol', 'place', {
      minzoom: 5,
      maxzoom: 10,
      filter: ['all', hasName, place(['state', 'province'])],
      layout: {
        'text-field': name,
        'text-font': REGULAR,
        'text-size': byZoom([
          [5, 10],
          [9, 12],
        ]),
        'text-max-width': 9,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.1,
      },
      paint: { 'text-color': palette.labelMuted, ...halo(palette) },
    }),
    fromSource('place-country', 'symbol', 'place', {
      maxzoom: 8,
      filter: ['all', hasName, place(['country'])],
      layout: {
        'text-field': name,
        'text-font': BOLD,
        'text-size': byZoom([
          [2, 10],
          [6, 14],
        ]),
        'text-max-width': 8,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.1,
      },
      paint: { 'text-color': palette.label, ...halo(palette) },
    }),
  )
  return layers
}

/** Растровая подложка в тёмной теме приглушается, в muted — обесцвечивается. */
function rasterPaint(theme: BasemapTheme): Json {
  if (theme === 'dark') return { 'raster-brightness-max': 0.75, 'raster-saturation': -0.2 }
  if (theme === 'muted') return { 'raster-saturation': -0.8, 'raster-opacity': 0.7 }
  return {}
}

export function basemapStyle(options: StyleOptions): Json {
  const palette = PALETTES[options.theme]
  const { content } = options
  const layers: Layer[] = [
    { id: 'background', type: 'background', paint: { 'background-color': palette.background } },
  ]
  const sources: Json = {}
  const view: Json = {}

  if (content.kind === 'vector') {
    sources[SOURCE] = {
      type: 'vector',
      url: `pmtiles://${content.archive}`,
      ...(content.attribution ? { attribution: content.attribution } : {}),
    }
    layers.push(...vectorLayers(palette, options.lang))
    if (content.center) {
      view.center = [content.center[0], content.center[1]]
      view.zoom = content.center[2]
    }
  } else if (content.kind === 'raster') {
    sources.raster = {
      type: 'raster',
      tiles: [content.tiles],
      tileSize: content.tileSize,
      minzoom: content.minZoom,
      maxzoom: content.maxZoom,
      ...(content.bounds ? { bounds: content.bounds } : {}),
      ...(content.attribution ? { attribution: content.attribution } : {}),
    }
    layers.push({
      id: 'raster',
      type: 'raster',
      source: 'raster',
      paint: rasterPaint(options.theme),
    })
  }

  // Слои данных карта вставляет под первую подпись подложки: подписи читаются поверх данных
  const firstSymbol = layers.find((layer) => layer.type === 'symbol')?.id ?? null
  return {
    version: 8,
    name: options.name,
    metadata: {
      'kchs:basemap': options.id,
      'kchs:kind': content.kind,
      'kchs:theme': options.theme,
      'kchs:firstSymbolLayer': firstSymbol,
    },
    ...view,
    sources,
    glyphs: options.urls.glyphs,
    sprite: options.urls.sprite,
    layers,
  }
}
