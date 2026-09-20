import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { BasemapServiceParams, RasterTileSize, ServiceUrl } from './basemap.js'
import { Bbox } from './layer.js'

/**
 * Слой-ссылка на внешнюю ГИС-службу — объект реестра `service_layer`
 * (07-gis-engine.md §5, §8; 14-automation-integrations.md §5; ADR-0108).
 * Растровые службы (XYZ, WMS, WMTS) рисуются подложкой поверх или под данными;
 * векторные (WFS, ArcGIS REST) отдают объекты GeoJSON и разово импортируются в
 * датасет обычным геоимпортом движка. Ключ доступа хранится шифром, в браузер
 * не попадает: и тайлы, и объекты идут через прокси API с кэшем.
 */
export const SERVICE_LAYER_KINDS = ['xyz', 'wms', 'wmts', 'wfs', 'arcgis'] as const
export const ServiceLayerKind = z.enum(SERVICE_LAYER_KINDS)
export type ServiceLayerKind = z.infer<typeof ServiceLayerKind>

/** Растровые виды: рисуются тайлами через прокси. */
export const RASTER_SERVICE_KINDS = ['xyz', 'wms', 'wmts'] as const
/** Векторные виды: отдают объекты и импортируются в датасет. */
export const VECTOR_SERVICE_KINDS = ['wfs', 'arcgis'] as const

/** Параметры службы WFS (GetFeature) — прокси добавляет охват и лимит. */
export const WfsParams = z.object({
  typeName: z.string().trim().min(1).max(300),
  version: z.enum(['1.1.0', '2.0.0']).default('2.0.0'),
  /** Фильтр CQL службы, если она его понимает. */
  cql: z.string().trim().max(2000).default(''),
})
export type WfsParams = z.infer<typeof WfsParams>

/** Параметры слоя ArcGIS REST Feature Service: `query` по номеру слоя. */
export const ArcgisParams = z.object({
  /** Номер слоя в службе (`/FeatureServer/0`). */
  layer: z.number().int().min(0).max(999).default(0),
  where: z.string().trim().max(2000).default('1=1'),
  outFields: z.string().trim().max(2000).default('*'),
})
export type ArcgisParams = z.infer<typeof ArcgisParams>

/** Параметры службы по виду: у XYZ их нет. */
export const ServiceLayerParams = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('xyz') }),
  BasemapServiceParams.options[0],
  BasemapServiceParams.options[1],
  z.object({ ...WfsParams.shape, kind: z.literal('wfs') }),
  z.object({ ...ArcgisParams.shape, kind: z.literal('arcgis') }),
])
export type ServiceLayerParams = z.infer<typeof ServiceLayerParams>

/** Больше объектов слой-ссылка за раз не отдаёт и не импортирует. */
export const SERVICE_LAYER_FEATURES_LIMIT = 5000
/** Столько объектов забирает разовый импорт (страницами). */
export const SERVICE_LAYER_IMPORT_LIMIT = 200_000
/** Сколько живёт кэш ответа службы, секунд. */
export const SERVICE_LAYER_CACHE_TTL = 300

const ZoomLevel = z.number().int().min(0).max(24)

export const ServiceLayerRecord = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  kind: ServiceLayerKind,
  /** Адрес службы — только управляющим внешними службами. */
  url: z.string().nullable(),
  params: ServiceLayerParams,
  /** У службы задан ключ доступа (сам ключ не отдаётся). */
  hasKey: z.boolean(),
  attribution: z.string().nullable(),
  minZoom: z.number().int(),
  maxZoom: z.number().int(),
  opacity: z.number().min(0).max(1),
  tileSize: RasterTileSize,
  bounds: Bbox.nullable(),
  status: z.enum(['unknown', 'ok', 'error']),
  statusMessage: z.string().nullable(),
  lastCheckAt: Timestamp.nullable(),
  canManage: z.boolean(),
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type ServiceLayerRecord = z.infer<typeof ServiceLayerRecord>

export const ServiceLayerList = z.object({ items: z.array(ServiceLayerRecord) })
export type ServiceLayerList = z.infer<typeof ServiceLayerList>

const serviceShape = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  kind: ServiceLayerKind,
  url: z.string().trim().min(1).max(2000),
  params: ServiceLayerParams,
  apiKey: z.string().trim().min(1).max(500).optional(),
  attribution: z.string().trim().max(500).nullable().optional(),
  minZoom: ZoomLevel.default(0),
  maxZoom: ZoomLevel.default(19),
  opacity: z.number().min(0).max(1).default(1),
  tileSize: RasterTileSize.default(256),
}

/** Шаблон XYZ проверяется в сервисе: у него обязательны `{z}`, `{x}`, `{y}`. */
function checkKindParams(
  value: { kind?: string; params?: unknown; url?: string },
  context: z.RefinementCtx,
): void {
  if (value.params === undefined || value.kind === undefined) return
  if ((value.params as { kind?: string }).kind !== value.kind) {
    context.addIssue({
      code: 'custom',
      message: 'Вид параметров не совпадает с видом службы',
      path: ['params', 'kind'],
    })
    return
  }
  if (value.url === undefined || value.kind === 'xyz') return
  const parsed = ServiceUrl.safeParse(value.url)
  for (const issue of parsed.success ? [] : parsed.error.issues) {
    context.addIssue({ code: 'custom', message: issue.message, path: ['url'] })
  }
}

export const ServiceLayerCreateInput = z
  .object({ ...serviceShape, spaceId: Uuid, parentId: Uuid.nullable().optional() })
  .superRefine(checkKindParams)
export type ServiceLayerCreateInput = z.infer<typeof ServiceLayerCreateInput>

export const ServiceLayerUpdateInput = z
  .object({
    name: serviceShape.name.optional(),
    description: serviceShape.description,
    kind: ServiceLayerKind.optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    params: ServiceLayerParams.optional(),
    /** `null` снимает ключ доступа. */
    apiKey: z.string().trim().min(1).max(500).nullable().optional(),
    attribution: serviceShape.attribution,
    minZoom: ZoomLevel.optional(),
    maxZoom: ZoomLevel.optional(),
    opacity: z.number().min(0).max(1).optional(),
    tileSize: RasterTileSize.optional(),
  })
  .superRefine(checkKindParams)
export type ServiceLayerUpdateInput = z.infer<typeof ServiceLayerUpdateInput>

/** Ответ на «Проверить соединение» со службой. */
export const ServiceLayerCheckResult = z.object({
  ok: z.boolean(),
  message: z.string(),
  checkedAt: Timestamp,
})
export type ServiceLayerCheckResult = z.infer<typeof ServiceLayerCheckResult>

export const ServiceLayerFeaturesQuery = z.object({
  /** Охват «запад,юг,восток,север» в WGS 84. */
  bbox: z
    .string()
    .max(200)
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SERVICE_LAYER_FEATURES_LIMIT)
    .default(SERVICE_LAYER_FEATURES_LIMIT),
})
export type ServiceLayerFeaturesQuery = z.infer<typeof ServiceLayerFeaturesQuery>

/**
 * Разовый импорт объектов службы в файл GeoJSON: дальше это обычный геоимпорт
 * (мастер импорта по `fileId`, ADR-0068) — движок читает файл GDAL.
 */
export const ServiceLayerImportInput = z.object({
  bbox: ServiceLayerFeaturesQuery.shape.bbox,
  limit: z.number().int().min(1).max(SERVICE_LAYER_IMPORT_LIMIT).default(50_000),
})
export type ServiceLayerImportInput = z.infer<typeof ServiceLayerImportInput>

export const ServiceLayerImportStarted = z.object({ jobId: Uuid })
export type ServiceLayerImportStarted = z.infer<typeof ServiceLayerImportStarted>

/** Результат задания выгрузки объектов службы (`JobRecord.result`). */
export const ServiceLayerImportResult = z.object({
  fileId: Uuid,
  fileName: z.string(),
  features: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export type ServiceLayerImportResult = z.infer<typeof ServiceLayerImportResult>
