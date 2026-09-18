import { TerritoryDetail, TerritoryList } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { db } from '~/shared/db/client.js'
import { objects, territories } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { TerritoryService } from './domain/territory-service.js'

const IdParam = z.object({ id: z.uuid() })

/** Типы объектов модуля GIS: в фазе 1 — территории (07-gis-engine.md §11). */
export function registerGisObjectTypes(): void {
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
}

export function registerGisRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/territories',
    auth: 'session',
    tags: ['gis'],
    summary: 'Справочник территорий: все единицы для дерева, пикеров и подписей',
    schema: { response: { 200: TerritoryList } },
    handler: async (request) => {
      // Справочник открыт сотрудникам (ACL everyone), гостю по ссылке — нет
      if (request.ctx.shareLink) throw errors.forbidden()
      return { items: await TerritoryService.list() }
    },
  })

  route({
    method: 'GET',
    url: '/territories/:id',
    auth: 'session',
    tags: ['gis'],
    summary: 'Карточка территории: путь от корня, дочерние единицы, атрибуты',
    schema: { params: IdParam, response: { 200: TerritoryDetail } },
    handler: async (request) => TerritoryService.get(request.ctx, request.params.id),
  })
}
