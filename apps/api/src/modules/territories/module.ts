import { eq } from 'drizzle-orm'
import { setTerritoryLookup } from '~/kernel/directory/territory-lookup.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { objects } from '~/kernel/objects/schema.js'
import { registerSystemDataset } from '~/kernel/system-datasets.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { TERRITORIES_SYSTEM_DATASET } from './domain/system-dataset.js'
import { territoryIndex } from './domain/territory-index.js'
import { registerTerritoryRoutes } from './http/territory-routes.js'
import { territories } from './schema.js'

/**
 * Справочник территорий — базовый модуль (07-gis-engine.md §11, ADR-0057, ADR-0180):
 * единицы административного деления, их границы, поиск по точке и геокодирование.
 * От него зависят данные, задачи, формы, документы, оргструктура и карты; сам он
 * опирается только на ядро.
 */
export function registerTerritoryObjectTypes(): void {
  registerObjectType({
    type: 'territory',
    labelKey: 'objects.types.territory',
    icon: 'territory',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      manage: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: false,
    // Код и названия на всех языках: «Хатлон», «Khatlon», «TJ-KT» находят одну единицу
    searchable: async (id) => {
      const [row] = await db()
        .select({
          title: objects.title,
          updatedAt: objects.updatedAt,
          code: territories.code,
          name: territories.name,
          level: territories.level,
        })
        .from(territories)
        .innerJoin(objects, eq(objects.id, territories.id))
        .where(eq(territories.id, id))
        .limit(1)
      if (!row) return null
      return {
        parentId: null,
        type: 'territory',
        spaceId: null,
        title: row.title,
        body: [row.code, row.name.ru, row.name.tg ?? '', row.name.en ?? ''].join('\n'),
        ownerId: null,
        updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
        meta: { code: row.code, level: row.level },
      }
    },
  })

  // Справочник с границами — источник запросов и цель шага spatial (ADR-0069)
  registerSystemDataset(TERRITORIES_SYSTEM_DATASET)
}

/**
 * Порт справочника территорий для оргструктуры ядра (ADR-0179): есть ли такая
 * территория у подразделения. Реализует его владелец справочника (ADR-0180).
 */
export function registerTerritoryLookup(): void {
  setTerritoryLookup({ exists: async (id) => (await territoryIndex()).byId.has(id) })
}

export function registerTerritoriesRoutes(route: RouteRegistrar): void {
  registerTerritoryRoutes(route)
}
