import { z } from 'zod'
import { Uuid } from '../common/primitives.js'
import { Bbox } from './layer.js'

/**
 * Карта — объект реестра `map`, композиция (07-gis-engine.md §1, §6): базовая
 * карта, слои с порядком, группами и прозрачностью, вид, закладки, привязка к
 * фильтрам дашборда, время. Состояние студии (видимость, вид) — ещё и во вкладке.
 */

export const MapCamera = z.object({
  /** [долгота, широта] WGS 84. */
  center: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  zoom: z.number().min(0).max(22),
  bearing: z.number().min(-360).max(360).default(0),
  pitch: z.number().min(0).max(85).default(0),
})
export type MapCamera = z.infer<typeof MapCamera>

export const MapLayerEntry = z.object({
  layerId: Uuid,
  visible: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
  /** Группа в дереве слоёв; null — корень. */
  group: z.string().max(120).nullable().default(null),
})
export type MapLayerEntry = z.infer<typeof MapLayerEntry>

/**
 * Слой-ссылка на внешнюю службу на карте (ADR-0108): растровые службы рисуются
 * под слоями данных, векторные — поверх подложки. Отдельным списком, чтобы
 * `layers` остался списком слоёв датасетов.
 */
export const MapServiceEntry = z.object({
  serviceId: Uuid,
  visible: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
})
export type MapServiceEntry = z.infer<typeof MapServiceEntry>

export const MapBookmark = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  camera: MapCamera,
})
export type MapBookmark = z.infer<typeof MapBookmark>

/** Режимы и шаги шкалы времени — те же, что у времени стиля слоя (`LayerStyle.time`). */
export const MAP_TIME_MODES = ['instant', 'range', 'cumulative'] as const
export type MapTimeMode = (typeof MAP_TIME_MODES)[number]
export const MAP_TIME_STEPS = ['hour', 'day', 'week', 'month', 'year'] as const
export type MapTimeStep = (typeof MAP_TIME_STEPS)[number]

/**
 * Время на карте (07-gis-engine.md §12, ADR-0074): интервал `from`–`to`
 * включительно — уходит тайлам слоёв со временем параметром `t=from/to`. Шаг
 * от суток — даты `ГГГГ-ММ-ДД`, часы — местное время пояса пользователя без
 * смещения (`ГГГГ-ММ-ДДTчч:мм:сс.ммм`), как понимает их компилятор запросов.
 * Режим и шаг шкалы — вместе с картой; не заданы — как у первого слоя со временем.
 */
export const MapTime = z.object({
  from: z.string().max(40),
  to: z.string().max(40),
  mode: z.enum(MAP_TIME_MODES).optional(),
  step: z.enum(MAP_TIME_STEPS).optional(),
})
export type MapTime = z.infer<typeof MapTime>

export const MapSpec = z.object({
  /** Базовая карта из реестра; null — по умолчанию установки. */
  basemapId: Uuid.nullable().default(null),
  camera: MapCamera.default({ center: [69.0, 38.6], zoom: 6, bearing: 0, pitch: 0 }),
  /** Порядок — снизу вверх: последний рисуется поверх. */
  layers: z.array(MapLayerEntry).max(50).default([]),
  /** Слои-ссылки на внешние ГИС-службы (ADR-0108). */
  services: z.array(MapServiceEntry).max(20).default([]),
  bookmarks: z.array(MapBookmark).max(100).default([]),
  /** Время на карте: интервал для слоёв со временем; null — время не ограничено. */
  time: MapTime.nullable().default(null),
})
export type MapSpec = z.infer<typeof MapSpec>
export type MapSpecInput = z.input<typeof MapSpec>

export const MapRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  spec: MapSpec,
  /** Общий экстент видимых слоёв — для «показать всё». */
  extent: Bbox.nullable(),
  version: z.number().int().nonnegative(),
})
export type MapRecord = z.infer<typeof MapRecord>

export const MapCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  spec: MapSpec.default({
    basemapId: null,
    camera: { center: [69.0, 38.6], zoom: 6, bearing: 0, pitch: 0 },
    layers: [],
    services: [],
    bookmarks: [],
    time: null,
  }),
})
export type MapCreateInput = z.infer<typeof MapCreateInput>

export const MapUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  spec: MapSpec.optional(),
})
export type MapUpdateInput = z.infer<typeof MapUpdateInput>
