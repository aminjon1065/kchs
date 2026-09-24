import { createHash } from 'node:crypto'
import {
  type Bbox,
  type LangText,
  type Territory,
  type TerritoryDetail,
  type TerritoryFeature,
  TerritoryLevel,
  type TerritoryLevel as TerritoryLevelValue,
} from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, territories, territoryClosure } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { redis } from '~/shared/redis/index.js'

/** Единица справочника для загрузки (seed, в будущем — импорт классификатора). */
export interface TerritoryInput {
  code: string
  /** Код родителя; null — корень. */
  parent: string | null
  level: TerritoryLevelValue
  kind: string | null
  name: LangText
  /** Долгота и широта центроида, WGS 84. */
  centroid: [number, number] | null
  population?: number | null
}

/** Граница единицы для загрузки (seed, в будущем — импорт границ). */
export interface TerritoryBoundaryInput {
  code: string
  /** Способ построения: `osm`, `circle`, `voronoi`… — в атрибуты единицы. */
  method: string
  /** GeoJSON Polygon или MultiPolygon в WGS 84. */
  geometry: { type: string; coordinates: unknown }
}

/** Происхождение границы в `attributes.boundary`: хэш сверяется при повторной загрузке. */
interface BoundaryAttribute {
  source: string
  method: string
  hash: string
}

/** Численность населения единицы для загрузки (seed, в будущем — импорт статистики). */
export interface TerritoryPopulationInput {
  code: string
  population: number
  /**
   * Способ: `official` — строка статистической таблицы, `official_sum` — сумма города
   * и одноимённого района, `estimate_share` — доля официального итога по оценке.
   */
  method: string
}

/** Происхождение численности в `attributes.population_source`. */
interface PopulationSource {
  source: string
  /** Дата, на которую приведена численность, `YYYY-MM-DD`. */
  date: string
  method: string
}

/** Номер версии справочника: процессы сверяют с ним свои кэши. */
const VERSION_KEY = 'kchs:territories:version'

const LEVEL_ORDER = new Map(TerritoryLevel.options.map((level, index) => [level, index]))

/** Граница из хранения или ввода — валидный MultiPolygon WGS 84, внешние кольца против часовой. */
const validBoundary = (geometry: SQL) =>
  sql`ST_ForcePolygonCCW(ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(${geometry}, 4326)), 3)))`

/** Экстент границы: [запад, юг, восток, север] или null. */
const bboxColumn = sql<Bbox | null>`CASE WHEN ${territories.geom} IS NULL THEN NULL
  ELSE json_build_array(ST_XMin(${territories.geom}), ST_YMin(${territories.geom}),
    ST_XMax(${territories.geom}), ST_YMax(${territories.geom})) END`

/**
 * Допуск упрощения границы для зума — пиксель тайла 512 px в градусах; мельче сетки
 * хранения границ (1e-4°, ADR-0067) не упрощаем.
 */
export function simplifyTolerance(zoom: number): number {
  const tolerance = 360 / (512 * 2 ** zoom)
  return tolerance < 1e-4 ? 0 : tolerance
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

const columns = {
  id: territories.id,
  code: territories.code,
  parentId: territories.parentId,
  level: territories.level,
  name: territories.name,
  kind: sql<string | null>`${territories.attributes}->>'kind'`,
  lon: sql<number | null>`ST_X(${territories.centroid})`,
  lat: sql<number | null>`ST_Y(${territories.centroid})`,
}

type Row = {
  id: string
  code: string
  parentId: string | null
  level: string
  name: LangText
  kind: string | null
  lon: number | null
  lat: number | null
}

function toTerritory(row: Row): Territory {
  return {
    id: row.id,
    code: row.code,
    parentId: row.parentId,
    level: TerritoryLevel.parse(row.level),
    name: row.name,
    kind: row.kind,
    centroid: row.lon !== null && row.lat !== null ? { lon: row.lon, lat: row.lat } : null,
  }
}

/** Родители раньше детей: по уровню, затем по коду. */
function topological(items: TerritoryInput[]): TerritoryInput[] {
  return [...items].sort(
    (a, b) =>
      (LEVEL_ORDER.get(a.level) ?? 0) - (LEVEL_ORDER.get(b.level) ?? 0) ||
      a.code.localeCompare(b.code),
  )
}

/**
 * Территории (07-gis-engine.md §11, ADR-0057): справочник в таблице
 * `territories` с замыканием `territory_closure`. Каждая единица — объект
 * реестра типа `territory`, видимый всем сотрудникам (ACL `everyone:*`).
 */
export const TerritoryService = {
  /**
   * Загрузка справочника: новые коды создаются, существующие не меняются —
   * повторный запуск ничего не делает. Возвращает число созданных единиц.
   */
  async load(tx: Executor, ctx: Ctx, items: TerritoryInput[]): Promise<number> {
    const existing = await tx
      .select({ id: territories.id, code: territories.code })
      .from(territories)
    const ids = new Map(existing.map((row) => [row.code, row.id]))
    let created = 0
    for (const item of topological(items)) {
      if (ids.has(item.code)) continue
      const parentId = item.parent ? ids.get(item.parent) : null
      if (item.parent && !parentId) {
        throw errors.validation(`Нет родительской территории «${item.parent}» для «${item.code}»`)
      }
      const object = await ObjectService.create(tx, ctx, {
        type: 'territory',
        spaceId: null,
        title: item.name.ru,
        subtitle: item.code,
        ownerId: null,
        meta: { code: item.code, level: item.level },
      })
      await tx.insert(territories).values({
        id: object.id,
        code: item.code,
        parentId: parentId ?? null,
        level: item.level,
        name: item.name,
        centroid: item.centroid
          ? sql`ST_SetSRID(ST_MakePoint(${item.centroid[0]}, ${item.centroid[1]}), 4326)`
          : null,
        attributes: {
          ...(item.kind ? { kind: item.kind } : {}),
          ...(item.population ? { population: item.population } : {}),
        },
      } as typeof territories.$inferInsert)
      await tx
        .insert(territoryClosure)
        .values({ territoryId: object.id, ancestorId: object.id, depth: 0 })
      if (parentId) {
        await tx.execute(sql`
          INSERT INTO ${territoryClosure} (territory_id, ancestor_id, depth)
          SELECT ${object.id}::uuid, tc.ancestor_id, tc.depth + 1
            FROM ${territoryClosure} tc WHERE tc.territory_id = ${parentId}::uuid`)
      }
      // Справочник общий: читают все сотрудники (и находят в поиске)
      await grantAccess(tx, ctx, object.id, [
        { principal: { type: 'everyone', id: '*' }, level: 'view' },
      ])
      ids.set(item.code, object.id)
      created += 1
    }
    return created
  },

  /**
   * Границы (ADR-0067): заданные единицы получают свою границу, их предки без своей —
   * объединение границ детей (регион — районов, страна — регионов). Центроид — точка
   * внутри границы: прежний центр, если он внутри, иначе `ST_PointOnSurface`; площадь —
   * по сфероиду. Повтор с теми же границами ничего не меняет: сверяется хэш источника.
   * Каждая изменённая единица публикует `territory.updated`; возвращает их число.
   */
  async loadBoundaries(
    tx: Executor,
    ctx: Ctx,
    input: { source: string; units: TerritoryBoundaryInput[] },
  ): Promise<number> {
    const rows = await tx
      .select({
        id: territories.id,
        code: territories.code,
        parentId: territories.parentId,
        level: territories.level,
        name: territories.name,
        boundary: sql<BoundaryAttribute | null>`${territories.attributes} -> 'boundary'`,
      })
      .from(territories)
      .innerJoin(objects, eq(objects.id, territories.id))
      .where(isNull(objects.deletedAt))
    const byCode = new Map(rows.map((row) => [row.code, row]))
    // Хэш границы каждой единицы — с учётом загруженных сейчас
    const hashes = new Map<string, string>()
    for (const row of rows) if (row.boundary) hashes.set(row.id, row.boundary.hash)
    const changed: typeof rows = []

    const store = async (
      row: (typeof rows)[number],
      geometry: SQL,
      boundary: BoundaryAttribute,
    ) => {
      await tx
        .update(territories)
        .set({
          geom: validBoundary(geometry),
          attributes: sql`${territories.attributes} || jsonb_build_object('boundary', ${JSON.stringify(boundary)}::jsonb)`,
          updatedAt: sql`now()`,
        })
        .where(eq(territories.id, row.id))
      hashes.set(row.id, boundary.hash)
      changed.push(row)
    }

    for (const unit of input.units) {
      const row = byCode.get(unit.code)
      if (!row) throw errors.validation(`Нет территории «${unit.code}» для границы`)
      const hash = hashOf(unit.geometry)
      if (row.boundary?.hash === hash) continue
      await store(row, sql`ST_GeomFromGeoJSON(${JSON.stringify(unit.geometry)})`, {
        source: input.source,
        method: unit.method,
        hash,
      })
    }

    // Предки без своей границы — от мелких уровней к крупным: регион раньше страны
    const explicit = new Set(input.units.map((unit) => unit.code))
    const children = new Map<string, typeof rows>()
    for (const row of rows) {
      if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row])
    }
    const depth = (level: string) => LEVEL_ORDER.get(TerritoryLevel.parse(level)) ?? 0
    const parents = rows
      .filter((row) => !explicit.has(row.code) && children.has(row.id))
      .sort((a, b) => depth(b.level) - depth(a.level))
    for (const parent of parents) {
      const parts = (children.get(parent.id) ?? [])
        .filter((child) => hashes.has(child.id))
        .map((child) => `${child.code}:${hashes.get(child.id)}`)
        .sort()
      if (parts.length === 0) continue
      const hash = hashOf(parts)
      if (parent.boundary?.hash === hash) continue
      const union = sql`(SELECT ST_Union(c.geom) FROM ${territories} c
        JOIN ${objects} o ON o.id = c.id AND o.deleted_at IS NULL
        WHERE c.parent_id = ${parent.id} AND c.geom IS NOT NULL)`
      await store(parent, union, { source: input.source, method: 'union', hash })
    }
    if (changed.length === 0) return 0

    const ids = changed.map((row) => row.id)
    const empty = await tx
      .select({ code: territories.code })
      .from(territories)
      .where(and(inArray(territories.id, ids), sql`ST_IsEmpty(${territories.geom})`))
    if (empty.length > 0) {
      throw errors.validation(
        `Пустая граница у территорий: ${empty.map((row) => row.code).join(', ')}`,
      )
    }
    await tx
      .update(territories)
      .set({
        centroid: sql`CASE WHEN ${territories.centroid} IS NOT NULL
          AND ST_Covers(${territories.geom}, ${territories.centroid}) THEN ${territories.centroid}
          ELSE ST_PointOnSurface(${territories.geom}) END`,
        areaKm2: sql`ST_Area(${territories.geom}::geography) / 1e6`,
      })
      .where(inArray(territories.id, ids))
    for (const row of changed) {
      await publishEvent(tx, ctx, {
        type: 'territory.updated',
        object: { id: row.id, type: 'territory', spaceId: null, title: row.name.ru },
        payload: { code: row.code },
        changedFields: ['geom', 'centroid', 'areaKm2'],
      })
    }
    return changed.length
  },

  /**
   * Численность населения (вопрос N7): единица получает число и его происхождение —
   * источник, дату и способ (`attributes.population_source`), их видят карточка и
   * паспорт территории. Повтор с теми же данными ничего не меняет; изменённая единица
   * публикует `territory.updated`. Возвращает число изменённых единиц.
   */
  async loadPopulation(
    tx: Executor,
    ctx: Ctx,
    input: { source: string; date: string; units: TerritoryPopulationInput[] },
  ): Promise<number> {
    const rows = await tx
      .select({
        id: territories.id,
        code: territories.code,
        name: territories.name,
        population: sql<unknown>`${territories.attributes} -> 'population'`,
        origin: sql<PopulationSource | null>`${territories.attributes} -> 'population_source'`,
      })
      .from(territories)
      .innerJoin(objects, eq(objects.id, territories.id))
      .where(isNull(objects.deletedAt))
    const byCode = new Map(rows.map((row) => [row.code, row]))
    let changed = 0
    for (const unit of input.units) {
      const row = byCode.get(unit.code)
      if (!row) throw errors.validation(`Нет территории «${unit.code}» для численности населения`)
      if (!Number.isInteger(unit.population) || unit.population < 0) {
        throw errors.validation(`Численность населения «${unit.code}» — не целое неотрицательное`)
      }
      const origin: PopulationSource = {
        source: input.source,
        date: input.date,
        method: unit.method,
      }
      if (
        row.population === unit.population &&
        row.origin?.source === origin.source &&
        row.origin.date === origin.date &&
        row.origin.method === origin.method
      ) {
        continue
      }
      await tx
        .update(territories)
        .set({
          attributes: sql`${territories.attributes} || jsonb_build_object(
            'population', ${unit.population}::bigint,
            'population_source', ${JSON.stringify(origin)}::jsonb)`,
          updatedAt: sql`now()`,
        })
        .where(eq(territories.id, row.id))
      await publishEvent(tx, ctx, {
        type: 'territory.updated',
        object: { id: row.id, type: 'territory', spaceId: null, title: row.name.ru },
        payload: { code: row.code },
        changedFields: ['population'],
      })
      changed += 1
    }
    return changed
  },

  /**
   * Справочник изменился — кэши процессов перечитают его при следующем обращении.
   * Версия — случайная метка, а не счётчик: после очистки Redis счётчик мог бы
   * совпасть с версией устаревшего кэша.
   */
  async invalidate(): Promise<void> {
    await redis().set(VERSION_KEY, newId())
  },

  async version(): Promise<string> {
    return (await redis().get(VERSION_KEY)) ?? 'none'
  },

  /** Все единицы справочника (без удалённых объектов) — по коду. */
  async list(database: Executor = db()): Promise<Territory[]> {
    const rows = await database
      .select(columns)
      .from(territories)
      .innerJoin(objects, eq(objects.id, territories.id))
      .where(isNull(objects.deletedAt))
      .orderBy(asc(territories.code))
    return rows.map((row) => toTerritory(row as Row))
  },

  /** Карточка: путь от корня, дочерние единицы, атрибуты. */
  async get(ctx: Ctx, id: string): Promise<TerritoryDetail> {
    await authorize(ctx, 'view', id)
    const [row] = await db()
      .select({
        ...columns,
        attributes: territories.attributes,
        areaKm2: territories.areaKm2,
        hasGeometry: sql<boolean>`${territories.geom} IS NOT NULL`,
        bbox: bboxColumn,
      })
      .from(territories)
      .where(eq(territories.id, id))
      .limit(1)
    if (!row) throw errors.notFound('Территория')
    const [path, children] = await Promise.all([
      db()
        .select(columns)
        .from(territoryClosure)
        .innerJoin(territories, eq(territories.id, territoryClosure.ancestorId))
        .where(and(eq(territoryClosure.territoryId, id), sql`${territoryClosure.depth} > 0`))
        .orderBy(sql`${territoryClosure.depth} DESC`),
      db()
        .select(columns)
        .from(territories)
        .innerJoin(objects, eq(objects.id, territories.id))
        .where(and(eq(territories.parentId, id), isNull(objects.deletedAt)))
        .orderBy(asc(territories.code)),
    ])
    const { attributes, areaKm2, hasGeometry, bbox, ...base } = row
    return {
      ...toTerritory(base as Row),
      path: path.map((item) => toTerritory(item as Row)),
      children: children.map((item) => toTerritory(item as Row)),
      attributes,
      areaKm2,
      hasGeometry,
      bbox,
    }
  },

  /**
   * Граница GeoJSON Feature (07-gis-engine.md §11: карта паспорта территории). С зумом —
   * упрощена до пикселя и с точностью координат под него; без границы — 404.
   */
  async feature(ctx: Ctx, id: string, zoom?: number): Promise<TerritoryFeature> {
    await authorize(ctx, 'view', id)
    const tolerance = zoom === undefined ? 0 : simplifyTolerance(zoom)
    // Знаков после запятой — на порядок точнее пикселя, не больше шести (≈ 0,1 м)
    const digits =
      zoom === undefined
        ? 6
        : Math.min(6, Math.max(3, Math.ceil(-Math.log10(360 / (512 * 2 ** zoom))) + 1))
    const shape =
      tolerance > 0
        ? sql`ST_SimplifyPreserveTopology(${territories.geom}, ${tolerance})`
        : sql`${territories.geom}`
    const [row] = await db()
      .select({
        code: territories.code,
        level: territories.level,
        name: territories.name,
        bbox: bboxColumn,
        geometry: sql<Record<string, unknown> | null>`ST_AsGeoJSON(${shape}, ${digits})::json`,
      })
      .from(territories)
      .where(eq(territories.id, id))
      .limit(1)
    if (!row) throw errors.notFound('Территория')
    if (!row.geometry || !row.bbox) throw errors.notFound('Граница территории')
    return {
      type: 'Feature',
      id,
      bbox: row.bbox,
      properties: { code: row.code, level: TerritoryLevel.parse(row.level), name: row.name },
      geometry: row.geometry,
    }
  },
}
