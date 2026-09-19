import {
  FeatureEdit,
  FeatureEditInput,
  FeatureEditList,
  FeatureEditReview,
  FeatureEditsQuery,
  LayerEditAccess,
  LayerFeature,
  LayerFeatureDelete,
  LayerFeatureInput,
  LayerFeaturePatch,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { FeatureEditService } from '../domain/feature-edit-service.js'

const IdParam = z.object({ id: z.uuid() })
const RowParams = z.object({ id: z.uuid(), rowId: z.string().regex(/^\d{1,18}$/) })
const EditParams = z.object({ id: z.uuid(), editId: z.string().regex(/^\d{1,18}$/) })

/**
 * Правка объектов слоя на карте и модерация правок (07-gis-engine.md §7, ADR-0076).
 * Правка напрямую — действие `edit_features` (edit на слой) и право писать строки
 * датасета; предложение — `suggest_features` (comment) на модерируемом слое.
 */
export function registerFeatureRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/gis/layers/:id/editing',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Как пользователь правит объекты слоя: напрямую, на проверку или никак',
    schema: { params: IdParam, response: { 200: LayerEditAccess } },
    handler: async (request) => FeatureEditService.access(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/gis/layers/:id/features',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Добавить объект слоя: строка датасета с геометрией',
    schema: { params: IdParam, body: LayerFeatureInput, response: { 200: LayerFeature } },
    handler: async (request) =>
      FeatureEditService.create(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'PATCH',
    url: '/gis/layers/:id/features/:rowId',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Изменить объект слоя: поля и геометрию; устаревшая версия — 409 с текущими',
    schema: { params: RowParams, body: LayerFeaturePatch, response: { 200: LayerFeature } },
    handler: async (request) =>
      FeatureEditService.update(request.ctx, request.params.id, request.params.rowId, request.body),
  })

  route({
    method: 'DELETE',
    url: '/gis/layers/:id/features/:rowId',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Удалить объект слоя той версии, что видел пользователь',
    schema: {
      params: RowParams,
      querystring: LayerFeatureDelete,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
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
    method: 'GET',
    url: '/gis/layers/:id/edits',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Правки модерируемого слоя: проверяющему — все, автору — свои',
    schema: { params: IdParam, querystring: FeatureEditsQuery, response: { 200: FeatureEditList } },
    handler: async (request) => ({
      items: await FeatureEditService.list(request.ctx, request.params.id, request.query),
    }),
  })

  route({
    method: 'POST',
    url: '/gis/layers/:id/edits',
    auth: { action: 'suggest_features' },
    tags: ['gis'],
    summary: 'Предложить правку объекта модерируемого слоя — на проверку владельцу',
    schema: { params: IdParam, body: FeatureEditInput, response: { 200: FeatureEdit } },
    handler: async (request) =>
      FeatureEditService.submit(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/gis/layers/:id/edits/:editId/review',
    auth: { action: 'edit_features' },
    tags: ['gis'],
    summary: 'Принять правку (применить строкой датасета) или отклонить',
    schema: { params: EditParams, body: FeatureEditReview, response: { 200: FeatureEdit } },
    handler: async (request) =>
      FeatureEditService.review(
        request.ctx,
        request.params.id,
        request.params.editId,
        request.body,
      ),
  })
}
