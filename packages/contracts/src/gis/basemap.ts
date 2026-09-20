import { z } from 'zod'
import { Locale, Timestamp, Uuid } from '../common/primitives.js'
import { Bbox } from './layer.js'

/**
 * Базовая карта — объект реестра `basemap` (07-gis-engine.md §5, ADR-0066):
 * векторная подложка PMTiles из сборки Planetiler, растровая XYZ через прокси
 * API или «без подложки» (только фон). Стиль MapLibre отдаёт API
 * (`/gis/basemaps/{id}/style.json`) с абсолютными адресами тайлов, шрифтов и спрайтов.
 * Внешние службы WMS и WMTS (ADR-0108) — те же растровые тайлы: прокси собирает
 * запрос службы по номеру тайла, ключ доступа остаётся на сервере.
 */

export const BASEMAP_KINDS = ['vector', 'raster', 'wms', 'wmts', 'none'] as const
export const BasemapKind = z.enum(BASEMAP_KINDS)
export type BasemapKind = z.infer<typeof BasemapKind>

/** Растровые виды подложки: тайлы идут через прокси API с кэшем в хранилище. */
export const RASTER_BASEMAP_KINDS = ['raster', 'wms', 'wmts'] as const
export type RasterBasemapKind = (typeof RASTER_BASEMAP_KINDS)[number]

/** Варианты стиля: светлый и тёмный — по теме интерфейса, приглушённый — под тематические слои. */
export const BASEMAP_THEMES = ['light', 'dark', 'muted'] as const
export const BasemapTheme = z.enum(BASEMAP_THEMES)
export type BasemapTheme = z.infer<typeof BasemapTheme>

/**
 * Шрифты подписей (glyphs) в хранилище установки: кириллица с таджикскими
 * буквами. Подписи слоёв данных ссылаются на них же — других шрифтов у карты нет.
 */
export const BASEMAP_FONTS = {
  regular: 'Noto Sans Regular',
  bold: 'Noto Sans Bold',
  italic: 'Noto Sans Italic',
} as const

/** Размер растрового тайла сервера, px. */
export const RasterTileSize = z.union([z.literal(256), z.literal(512)])

const ZoomLevel = z.number().int().min(0).max(24)

const PLACEHOLDER = /\{([^{}]*)\}/g
const ALLOWED_PLACEHOLDERS = new Set(['z', 'x', 'y', 'key'])

/**
 * Шаблон адреса растрового сервера: http(s), обязательные `{z}`, `{x}`, `{y}`;
 * ключ доступа — `{key}`, сам ключ хранится отдельно и клиенту не отдаётся.
 */
export const RasterUrlTemplate = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((value, context) => {
    const names = [...value.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')
    const unknown = names.filter((name) => !ALLOWED_PLACEHOLDERS.has(name))
    if (unknown.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `Поддерживаются {z}, {x}, {y} и {key}; лишнее: ${unknown.map((name) => `{${name}}`).join(', ')}`,
      })
      return
    }
    for (const required of ['z', 'x', 'y']) {
      if (!names.includes(required)) {
        context.addIssue({ code: 'custom', message: `В шаблоне нет {${required}}` })
        return
      }
    }
    let url: URL
    try {
      url = new URL(value.replace(PLACEHOLDER, '0'))
    } catch {
      context.addIssue({ code: 'custom', message: 'Некорректный адрес' })
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      context.addIssue({
        code: 'custom',
        message: 'Адрес должен начинаться с http:// или https://',
      })
    } else if (url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'Учётные данные в адресе не допускаются: ключ укажите отдельно',
      })
    }
  })

/**
 * Адрес службы WMS/WMTS: http(s) без номера тайла — запрос собирает прокси.
 * Ключ доступа подставляется вместо `{key}` и клиенту не отдаётся.
 */
export const ServiceUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .superRefine((value, context) => {
    const names = [...value.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')
    const unknown = names.filter((name) => name !== 'key')
    if (unknown.length > 0) {
      context.addIssue({
        code: 'custom',
        message: `Номер тайла подставляет прокси; лишнее: ${unknown.map((name) => `{${name}}`).join(', ')}`,
      })
      return
    }
    let url: URL
    try {
      url = new URL(value.replace(PLACEHOLDER, 'k'))
    } catch {
      context.addIssue({ code: 'custom', message: 'Некорректный адрес' })
      return
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      context.addIssue({
        code: 'custom',
        message: 'Адрес должен начинаться с http:// или https://',
      })
    } else if (url.username || url.password) {
      context.addIssue({
        code: 'custom',
        message: 'Учётные данные в адресе не допускаются: ключ укажите отдельно',
      })
    }
  })

/** Параметры службы WMS: прокси добавляет к ним охват тайла в EPSG:3857. */
export const WmsParams = z.object({
  layers: z.string().trim().min(1).max(500),
  version: z.enum(['1.1.1', '1.3.0']).default('1.3.0'),
  format: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  styles: z.string().trim().max(200).default(''),
  transparent: z.boolean().default(true),
})
export type WmsParams = z.infer<typeof WmsParams>

/** Параметры службы WMTS (KVP GetTile): прокси подставляет матрицу, строку и столбец. */
export const WmtsParams = z.object({
  layer: z.string().trim().min(1).max(300),
  tileMatrixSet: z.string().trim().min(1).max(200).default('GoogleMapsCompatible'),
  style: z.string().trim().max(200).default('default'),
  format: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  /**
   * Шаблон номера матрицы: `{z}` — номер масштаба. Некоторые службы называют
   * матрицы «EPSG:3857:{z}» или «{z}», поэтому шаблон настраивается.
   */
  tileMatrix: z.string().trim().min(1).max(120).default('{z}'),
})
export type WmtsParams = z.infer<typeof WmtsParams>

/** Параметры внешней растровой службы подложки — по виду. */
export const BasemapServiceParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wms'), ...WmsParams.shape }),
  z.object({ kind: z.literal('wmts'), ...WmtsParams.shape }),
])
export type BasemapServiceParams = z.infer<typeof BasemapServiceParams>

export const BasemapBuild = z.object({
  /** Версия сборки — дата выгрузки OSM или своя метка. */
  version: z.string(),
  bytes: z.number().int().nonnegative(),
  tiles: z.number().int().nonnegative(),
})
export type BasemapBuild = z.infer<typeof BasemapBuild>

export const Basemap = z.object({
  id: Uuid,
  /** Ключ сборки (`tajikistan`) или системной подложки (`none`); у добавленных вручную — null. */
  key: z.string().nullable(),
  name: z.string(),
  kind: BasemapKind,
  isDefault: z.boolean(),
  attribution: z.string().nullable(),
  minZoom: z.number().int(),
  maxZoom: z.number().int(),
  /** Охват данных подложки — для «показать всё» и ограничения запросов тайлов. */
  bounds: Bbox.nullable(),
  build: BasemapBuild.nullable(),
  /** Шаблон адреса растрового сервера — только управляющим подложками. */
  url: z.string().nullable(),
  /** У растрового сервера задан ключ доступа (сам ключ не отдаётся). */
  hasKey: z.boolean(),
  tileSize: RasterTileSize.nullable(),
  /** Параметры службы WMS/WMTS — только управляющим подложками. */
  service: BasemapServiceParams.nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type Basemap = z.infer<typeof Basemap>

export const BasemapList = z.object({ items: z.array(Basemap) })
export type BasemapList = z.infer<typeof BasemapList>

const zoomOrder = (value: { minZoom?: number; maxZoom?: number }) =>
  value.minZoom === undefined || value.maxZoom === undefined || value.minZoom <= value.maxZoom

/**
 * Адрес подложки по виду: XYZ — шаблон с номером тайла, WMS и WMTS — адрес
 * службы (номер тайла подставляет прокси).
 */
function checkServiceUrl(
  value: { kind?: string; url?: string; service?: unknown },
  context: z.RefinementCtx,
): void {
  if (value.url === undefined && value.service === undefined) return
  if (value.kind === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Вместе с адресом укажите вид подложки',
      path: ['kind'],
    })
    return
  }
  const raster = value.kind === 'raster'
  if (value.url !== undefined) {
    const parsed = (raster ? RasterUrlTemplate : ServiceUrl).safeParse(value.url)
    for (const issue of parsed.success ? [] : parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: ['url'] })
    }
  }
  if (!raster && value.service === undefined) {
    context.addIssue({ code: 'custom', message: 'Нужны параметры службы', path: ['service'] })
    return
  }
  if (value.service === undefined) return
  if (raster) {
    context.addIssue({
      code: 'custom',
      message: 'У XYZ-подложки параметров службы нет',
      path: ['service'],
    })
  } else if ((value.service as { kind?: string }).kind !== value.kind) {
    context.addIssue({
      code: 'custom',
      message: 'Вид службы не совпадает с видом подложки',
      path: ['service', 'kind'],
    })
  }
}

/**
 * Новая подложка — растровая XYZ или внешняя служба WMS/WMTS (ADR-0108);
 * векторные регистрирует сборка (`kchs basemaps sync`).
 */
export const BasemapCreateInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(RASTER_BASEMAP_KINDS).default('raster'),
    url: z.string().trim().min(1).max(2000),
    service: BasemapServiceParams.optional(),
    apiKey: z.string().trim().min(1).max(500).optional(),
    attribution: z.string().trim().max(500).nullable().default(null),
    minZoom: ZoomLevel.default(0),
    maxZoom: ZoomLevel.default(19),
    tileSize: RasterTileSize.default(256),
    isDefault: z.boolean().default(false),
  })
  .refine(zoomOrder, { message: 'Минимальный масштаб больше максимального', path: ['minZoom'] })
  .superRefine(checkServiceUrl)
export type BasemapCreateInput = z.infer<typeof BasemapCreateInput>

/**
 * Правка: название — у любой подложки; адрес, ключ, масштабы и атрибуция — у
 * растровой. `apiKey: null` снимает ключ.
 */
export const BasemapUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    /** Вид подложки менять нельзя — он проверяется вместе с адресом. */
    kind: z.enum(RASTER_BASEMAP_KINDS).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    service: BasemapServiceParams.optional(),
    apiKey: z.string().trim().min(1).max(500).nullable().optional(),
    attribution: z.string().trim().max(500).nullable().optional(),
    minZoom: ZoomLevel.optional(),
    maxZoom: ZoomLevel.optional(),
    tileSize: RasterTileSize.optional(),
  })
  .refine(zoomOrder, { message: 'Минимальный масштаб больше максимального', path: ['minZoom'] })
  .superRefine(checkServiceUrl)
export type BasemapUpdateInput = z.infer<typeof BasemapUpdateInput>

export const BasemapStyleQuery = z.object({
  theme: BasemapTheme.default('light'),
  /** Язык подписей: `name:<язык>`, затем русское и исходное название. */
  lang: Locale.default('ru'),
})
export type BasemapStyleQuery = z.infer<typeof BasemapStyleQuery>
