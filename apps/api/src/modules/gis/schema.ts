import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from '../../kernel/directory/schema.js'
import { objects } from '../../kernel/objects/schema.js'
import {
  bytea,
  createdAt,
  jsonbObject,
  type LangTextValue,
  tsCol,
  updatedAt,
} from '../../shared/db/columns.js'

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

/**
 * GIS (05-data-model.md §GIS, 07-gis-engine.md). Геометрия — PostGIS в WGS 84;
 * значения читаются и пишутся только функциями PostGIS в SQL (ST_AsGeoJSON, ST_X…).
 * Тип без схемы: `extensions` входит в search_path базы (ADR-0025).
 */
const geometry = (kind: 'MultiPolygon' | 'Point') =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `geometry(${kind}, 4326)`,
  })

/**
 * Территория — объект реестра типа `territory` (07-gis-engine.md §11, ADR-0057):
 * сквозной справочник административного деления. Вид единицы и население —
 * в `attributes`; границы появятся с данными фазы 2.
 */
export const territories = pgTable(
  'territories',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    code: text('code').notNull().unique(),
    // NO ACTION, а не RESTRICT: каскадное удаление объектов снимает всё дерево одним
    // оператором, проверка — в его конце; удалить единицу с детьми по-прежнему нельзя
    parentId: uuid('parent_id').references((): AnyPgColumn => territories.id),
    level: text('level').notNull(),
    name: jsonb('name').$type<LangTextValue>().notNull(),
    geom: geometry('MultiPolygon')('geom'),
    centroid: geometry('Point')('centroid'),
    areaKm2: doublePrecision('area_km2'),
    attributes: jsonbObject('attributes'),
    /** Строка справочного датасета территорий (зеркало, 07-gis-engine.md §11) — позже. */
    datasetRowId: bigint('dataset_row_id', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('territories_parent_idx').on(t.parentId),
    index('territories_level_idx').on(t.level),
    index('territories_geom_idx').using('gist', t.geom),
  ],
)

/** Замыкание иерархии: строка «сам себе» (глубина 0) и все предки. */
export const territoryClosure = pgTable(
  'territory_closure',
  {
    territoryId: uuid('territory_id')
      .notNull()
      .references(() => territories.id, { onDelete: 'cascade' }),
    ancestorId: uuid('ancestor_id')
      .notNull()
      .references(() => territories.id, { onDelete: 'cascade' }),
    depth: integer('depth').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.territoryId, t.ancestorId] }),
    index('territory_closure_ancestor_idx').on(t.ancestorId),
  ],
)

/**
 * Слой — объект реестра `layer` (07-gis-engine.md §1–4, ADR-0064): представление
 * датасета на карте. Стиль, подписи, карточка, фильтр и зумы — в `style`
 * (контракт LayerStyle); `tile_fields` — поля тайла сверх нужных стилю.
 */
export const layers = pgTable(
  'layers',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => objects.id, { onDelete: 'cascade' }),
    // Без внешнего ключа, как у графиков: слой удалённого датасета остаётся
    // объектом реестра и открывается с «нет доступа к данным»
    datasetId: uuid('dataset_id').notNull(),
    geometryField: text('geometry_field').notNull(),
    geometryType: text('geometry_type').notNull(),
    style: jsonb('style').$type<Record<string, unknown>>().notNull(),
    tileFields: text('tile_fields').array().notNull().default([]),
    editable: boolean('editable').notNull().default(false),
    moderated: boolean('moderated').notNull().default(false),
    settings: jsonbObject('settings'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('layers_dataset_idx').on(t.datasetId)],
)

/** Карта — объект реестра `map`: композиция слоёв, вид, закладки, время (MapSpec). */
export const maps = pgTable('maps', {
  id: uuid('id')
    .primaryKey()
    .references(() => objects.id, { onDelete: 'cascade' }),
  spec: jsonb('spec').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/**
 * Правки объектов модерируемого слоя (07-gis-engine.md §7, ADR-0076): предложение
 * пользователя без права править датасет ждёт проверки; принятая правка
 * применяется строкой датасета. Не объект реестра, а подзапись слоя: доступ
 * выводится из прав на слой и автора. История применённых правок — `ds.h_*`.
 */
export const featureEdits = pgTable(
  'feature_edits',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    layerId: uuid('layer_id')
      .notNull()
      .references(() => layers.id, { onDelete: 'cascade' }),
    datasetId: uuid('dataset_id').notNull(),
    /** Строка датасета: у создания — после применения. */
    rowId: bigint('row_id', { mode: 'number' }),
    /** create | update | delete */
    op: text('op').notNull(),
    /** Предложенные значения полей без геометрии. */
    values: jsonbObject('values'),
    /** Предложенная геометрия GeoJSON (WGS 84); null — не меняется. */
    geometry: jsonb('geometry').$type<Record<string, unknown> | null>(),
    /** Версия строки, от которой сделана правка изменения или удаления. */
    baseVer: integer('base_ver'),
    note: text('note'),
    /** pending | approved | rejected */
    status: text('status').notNull().default('pending'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    comment: text('comment'),
    createdAt: createdAt(),
    reviewedAt: tsCol('reviewed_at'),
  },
  (t) => [
    index('feature_edits_layer_idx').on(t.layerId, t.status, t.createdAt.desc()),
    index('feature_edits_author_idx').on(t.authorId, t.createdAt.desc()),
  ],
)
