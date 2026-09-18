import {
  type LangText,
  type Territory,
  type TerritoryDetail,
  TerritoryLevel,
  type TerritoryLevel as TerritoryLevelValue,
} from '@kchs/contracts'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { grantAccess } from '~/kernel/access/acl-service.js'
import { authorize } from '~/kernel/access/authorize.js'
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

/** Номер версии справочника: процессы сверяют с ним свои кэши. */
const VERSION_KEY = 'kchs:territories:version'

const LEVEL_ORDER = new Map(TerritoryLevel.options.map((level, index) => [level, index]))

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
    const { attributes, areaKm2, hasGeometry, ...base } = row
    return {
      ...toTerritory(base as Row),
      path: path.map((item) => toTerritory(item as Row)),
      children: children.map((item) => toTerritory(item as Row)),
      attributes,
      areaKm2,
      hasGeometry,
    }
  },
}
