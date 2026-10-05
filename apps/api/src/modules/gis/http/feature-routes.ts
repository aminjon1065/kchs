import type { RouteRegistrar } from '~/shared/http/route.js'
import { FeatureEditService } from '../domain/feature-edit-service.js'

/**
 * Правка объектов слоя на карте и модерация правок (07-gis-engine.md §7, ADR-0076).
 * Правка напрямую — действие `edit_features` (edit на слой) и право писать строки
 * датасета; предложение — `suggest_features` (comment) на модерируемом слое.
 */
export function registerFeatureRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /gis/layers/:id/editing',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Как пользователь правит объекты слоя: напрямую, на проверку или никак',
    handler: async (request) => FeatureEditService.access(request.ctx, request.params.id),
  })

  route({
    route: 'POST /gis/layers/:id/features',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Добавить объект слоя: строка датасета с геометрией',
    handler: async (request) =>
      FeatureEditService.create(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'PATCH /gis/layers/:id/features/:rowId',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Изменить объект слоя: поля и геометрию; устаревшая версия — 409 с текущими',
    handler: async (request) =>
      FeatureEditService.update(request.ctx, request.params.id, request.params.rowId, request.body),
  })

  route({
    route: 'DELETE /gis/layers/:id/features/:rowId',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Удалить объект слоя той версии, что видел пользователь',
    handler: async (request) => {
      await FeatureEditService.remove(
        request.ctx,
        request.params.id,
        request.params.rowId,
        request.query.ver,
      )
      return { ok: true }
    },
  })

  route({
    route: 'GET /gis/layers/:id/edits',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Правки модерируемого слоя: проверяющему — все, автору — свои',
    handler: async (request) => ({
      items: await FeatureEditService.list(request.ctx, request.params.id, request.query),
    }),
  })

  route({
    route: 'POST /gis/layers/:id/edits',
    auth: { action: 'suggest_features' },
    tags: ['gis'],
    summary: 'Предложить правку объекта модерируемого слоя — на проверку владельцу',
    handler: async (request) =>
      FeatureEditService.submit(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /gis/layers/:id/edits/:editId/review',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Принять правку (применить строкой датасета) или отклонить',
    handler: async (request) =>
      FeatureEditService.review(
        request.ctx,
        request.params.id,
        request.params.editId,
        request.body,
      ),
  })
}
