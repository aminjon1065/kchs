import { z } from 'zod'
import { Locale, Timestamp, Uuid } from '../common/primitives.js'
import { Bbox } from './layer.js'

/**
 * Базовая карта — объект реестра `basemap` (07-gis-engine.md §5, ADR-0066):
 * векторная подложка PMTiles из сборки Planetiler, растровая XYZ через прокси
 * API или «без подложки» (только фон). Стиль MapLibre отдаёт API
 * (`/gis/basemaps/{id}/style.json`) с абсолютными адресами тайлов, шрифтов и спрайтов.
 */

export const BASEMAP_KINDS = ['vector', 'raster', 'none'] as const
export const BasemapKind = z.enum(BASEMAP_KINDS)
export type BasemapKind = z.infer<typeof BasemapKind>

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
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type Basemap = z.infer<typeof Basemap>

export const BasemapList = z.object({ items: z.array(Basemap) })
export type BasemapList = z.infer<typeof BasemapList>

const zoomOrder = (value: { minZoom?: number; maxZoom?: number }) =>
  value.minZoom === undefined || value.maxZoom === undefined || value.minZoom <= value.maxZoom

/** Новая подложка — растровая XYZ; векторные регистрирует сборка (`kchs basemaps sync`). */
export const BasemapCreateInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.literal('raster').default('raster'),
    url: RasterUrlTemplate,
    apiKey: z.string().trim().min(1).max(500).optional(),
    attribution: z.string().trim().max(500).nullable().default(null),
    minZoom: ZoomLevel.default(0),
    maxZoom: ZoomLevel.default(19),
    tileSize: RasterTileSize.default(256),
    isDefault: z.boolean().default(false),
  })
  .refine(zoomOrder, { message: 'Минимальный масштаб больше максимального', path: ['minZoom'] })
export type BasemapCreateInput = z.infer<typeof BasemapCreateInput>

/**
 * Правка: название — у любой подложки; адрес, ключ, масштабы и атрибуция — у
 * растровой. `apiKey: null` снимает ключ.
 */
export const BasemapUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    url: RasterUrlTemplate.optional(),
    apiKey: z.string().trim().min(1).max(500).nullable().optional(),
    attribution: z.string().trim().max(500).nullable().optional(),
    minZoom: ZoomLevel.optional(),
    maxZoom: ZoomLevel.optional(),
    tileSize: RasterTileSize.optional(),
  })
  .refine(zoomOrder, { message: 'Минимальный масштаб больше максимального', path: ['minZoom'] })
export type BasemapUpdateInput = z.infer<typeof BasemapUpdateInput>

export const BasemapStyleQuery = z.object({
  theme: BasemapTheme.default('light'),
  /** Язык подписей: `name:<язык>`, затем русское и исходное название. */
  lang: Locale.default('ru'),
})
export type BasemapStyleQuery = z.infer<typeof BasemapStyleQuery>
