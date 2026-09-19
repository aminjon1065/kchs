import { sql } from 'drizzle-orm'
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, updatedAt } from './_shared.js'
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
    /** `vector` | `raster` | `none`. */
    kind: text('kind').notNull(),
    /** vector — ключ архива PMTiles в бакете тайлов; raster — шаблон XYZ без ключа доступа. */
    url: text('url'),
    /** vector — сведения сборки (версия, охват, центр, слои схемы); raster — размер тайла. */
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
