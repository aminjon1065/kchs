import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, tsCol, updatedAt } from './_shared.js'
import { bytea } from './identity.js'
import { objects } from './kernel.js'

/**
 * Базовая карта — объект реестра типа `basemap` (05-data-model.md §GIS,
 * 07-gis-engine.md §5, ADR-0066). Сверх модели данных — `key` (подложку из
 * сборки и системную «без подложки» находят по ключу) и `secret_enc` (ключ
 * доступа растрового сервера хранится шифром отдельно от шаблона адреса).
 */
export const basemaps = pgTable(
  'basemaps',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** Ключ сборки PMTiles (`tajikistan`) или `none`; у добавленных администратором — null. */
    key: text('key').unique(),
    /** `vector` | `raster` | `wms` | `wmts` | `none` (ADR-0066, ADR-0108). */
    kind: text('kind').notNull(),
    /**
     * vector — ключ архива PMTiles в бакете тайлов; raster — шаблон XYZ без
     * ключа доступа; wms/wmts — адрес службы (номер тайла ставит прокси).
     */
    url: text('url'),
    /**
     * vector — сведения сборки (версия, охват, центр, слои схемы); растровые —
     * размер тайла и `service` с параметрами WMS/WMTS.
     */
    style: jsonbObject('style'),
    attribution: text('attribution'),
    minZoom: integer('min_zoom').notNull().default(0),
    maxZoom: integer('max_zoom').notNull().default(22),
    isDefault: boolean('is_default').notNull().default(false),
    /** Ключ доступа растрового сервера (шифр KCHS_MASTER_KEY) — подставляется вместо `{key}`. */
    secretEnc: bytea('secret_enc'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Подложка по умолчанию у установки одна
  (t) => [uniqueIndex('basemaps_default_idx').on(t.isDefault).where(sql`${t.isDefault}`)],
)

/**
 * Слой-ссылка на внешнюю ГИС-службу — объект реестра типа `service_layer`
 * (07-gis-engine.md §5, §8; ADR-0108). Растровые службы (XYZ, WMS, WMTS) идут
 * тайлами через прокси с кэшем, векторные (WFS, ArcGIS REST) отдают объекты и
 * разово импортируются в датасет. Ключ доступа — шифром, наружу не отдаётся.
 */
export const serviceLayers = pgTable(
  'service_layers',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    /** `xyz` | `wms` | `wmts` | `wfs` | `arcgis`. */
    kind: text('kind').notNull(),
    /** Адрес службы: у XYZ — шаблон с `{z}/{x}/{y}`, у остальных — точка входа. */
    url: text('url').notNull(),
    /** Параметры службы по виду (`ServiceLayerParams`). */
    params: jsonbObject('params'),
    description: text('description'),
    attribution: text('attribution'),
    minZoom: integer('min_zoom').notNull().default(0),
    maxZoom: integer('max_zoom').notNull().default(19),
    opacity: real('opacity').notNull().default(1),
    tileSize: integer('tile_size').notNull().default(256),
    status: text('status').notNull().default('unknown'),
    statusMessage: text('status_message'),
    lastCheckAt: tsCol('last_check_at'),
    /** Ключ доступа службы (шифр KCHS_MASTER_KEY) — подставляется вместо `{key}`. */
    secretEnc: bytea('secret_enc'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('service_layers_kind_idx').on(t.kind)],
)
