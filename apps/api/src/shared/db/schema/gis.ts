import {
  type AnyPgColumn,
  bigint,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, jsonbObject, type LangTextValue, updatedAt } from './_shared.js'
import { objects } from './kernel.js'

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
