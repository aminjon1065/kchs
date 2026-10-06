import { z } from 'zod'
import {
  Basemap,
  BasemapCreateInput,
  BasemapList,
  BasemapStyleDocument,
  BasemapStyleQuery,
  BasemapUpdateInput,
} from '../../gis/basemap.js'
import {
  FeatureEdit,
  FeatureEditInput,
  FeatureEditList,
  FeatureEditReview,
  FeatureEditsQuery,
  LayerEditAccess,
  LayerFeatureDelete,
  LayerFeatureInput,
  LayerFeaturePatch,
} from '../../gis/feature-edit.js'
import {
  LayerCreateInput,
  LayerFeature,
  LayerFeatureCollection,
  LayerFeaturesQuery,
  LayerList,
  LayerRecord,
  LayerTileQuery,
  LayerUpdateInput,
} from '../../gis/layer.js'
import { LayerStats, LayerStatsInput } from '../../gis/layer-stats.js'
import { MapCreateInput, MapRecord, MapUpdateInput } from '../../gis/map.js'
import { TerritoryPassport, TerritoryPassportQuery } from '../../gis/passport.js'
import { GisRenderSettings, GisRenderSettingsPatch } from '../../gis/render-settings.js'
import {
  ServiceLayerCheckResult,
  ServiceLayerCreateInput,
  ServiceLayerFeatureCollection,
  ServiceLayerFeaturesQuery,
  ServiceLayerImportInput,
  ServiceLayerImportStarted,
  ServiceLayerList,
  ServiceLayerRecord,
  ServiceLayerUpdateInput,
} from '../../gis/service-layer.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam, Ok, RowParams } from '../params.js'

const ArchiveParams = IdParam.extend({
  file: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}\.pmtiles$/),
})

const TileParams = IdParam.extend({
  z: z.coerce.number().int().min(0).max(24),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
})

const GlyphParams = z.object({
  fontstack: z.string().regex(/^[A-Za-z0-9 ,_-]{1,200}$/),
  range: z.string().regex(/^\d{1,5}-\d{1,5}\.pbf$/),
})

const SpriteParams = z.object({
  file: z.string().regex(/^basemap-(light|dark|muted)(@2x)?\.(json|png)$/),
})

const EditParams = z.object({ id: z.uuid(), editId: z.string().regex(/^\d{1,18}$/) })

const DatasetLayersQuery = z.object({ datasetId: z.uuid() })

/**
 * Маршруты модуля «gis» (ADR-0188). Регистрация — `apps/api/src/modules/gis/`: basemaps.ts,
 * http/feature-routes.ts, http/passport-routes.ts, module.ts, service-layers.ts.
 */
export const gisRoutes = defineRoutes({
  'GET /gis/render-settings': { response: { 200: GisRenderSettings } },
  'PUT /admin/gis/render-settings': {
    body: GisRenderSettingsPatch,
    response: { 200: GisRenderSettings },
  },
  'GET /gis/basemaps': { response: { 200: BasemapList } },
  'POST /gis/basemaps': { body: BasemapCreateInput, response: { 200: Basemap } },
  'GET /gis/basemaps/:id': { params: IdParam, response: { 200: Basemap } },
  'PATCH /gis/basemaps/:id': {
    params: IdParam,
    body: BasemapUpdateInput,
    response: { 200: Basemap },
  },
  'DELETE /gis/basemaps/:id': { params: IdParam, response: { 200: Ok } },
  'POST /gis/basemaps/:id/default': { params: IdParam, response: { 200: Ok } },
  'GET /gis/basemaps/:id/style.json': {
    params: IdParam,
    query: BasemapStyleQuery,
    response: { 200: BasemapStyleDocument },
  },
  'GET /gis/basemaps/:id/pmtiles/:file': { params: ArchiveParams },
  'GET /gis/basemaps/:id/tiles/:z/:x/:y': { params: TileParams },
  'GET /gis/glyphs/:fontstack/:range': { params: GlyphParams },
  'GET /gis/sprites/:file': { params: SpriteParams },
  'GET /gis/layers/:id/editing': { params: IdParam, response: { 200: LayerEditAccess } },
  'POST /gis/layers/:id/features': {
    params: IdParam,
    body: LayerFeatureInput,
    response: { 200: LayerFeature },
  },
  'PATCH /gis/layers/:id/features/:rowId': {
    params: RowParams,
    body: LayerFeaturePatch,
    response: { 200: LayerFeature },
  },
  'DELETE /gis/layers/:id/features/:rowId': {
    params: RowParams,
    query: LayerFeatureDelete,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /gis/layers/:id/edits': {
    params: IdParam,
    query: FeatureEditsQuery,
    response: { 200: FeatureEditList },
  },
  'POST /gis/layers/:id/edits': {
    params: IdParam,
    body: FeatureEditInput,
    response: { 200: FeatureEdit },
  },
  'POST /gis/layers/:id/edits/:editId/review': {
    params: EditParams,
    body: FeatureEditReview,
    response: { 200: FeatureEdit },
  },
  'GET /gis/territories/:id/passport': {
    params: IdParam,
    query: TerritoryPassportQuery,
    response: { 200: TerritoryPassport },
  },
  'POST /gis/layers': { body: LayerCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /gis/layers': { query: DatasetLayersQuery, response: { 200: LayerList } },
  'GET /gis/layers/:id': { params: IdParam, response: { 200: LayerRecord } },
  'PATCH /gis/layers/:id': {
    params: IdParam,
    body: LayerUpdateInput,
    response: { 200: LayerRecord },
  },
  'POST /gis/layers/:id/stats': {
    params: IdParam,
    body: LayerStatsInput,
    response: { 200: LayerStats },
  },
  'GET /gis/layers/:id/tiles/:z/:x/:y.pbf': { params: TileParams, query: LayerTileQuery },
  'GET /gis/layers/:id/features': {
    params: IdParam,
    query: LayerFeaturesQuery,
    response: { 200: LayerFeatureCollection },
  },
  'GET /gis/layers/:id/features/:rowId': { params: RowParams, response: { 200: LayerFeature } },
  'POST /gis/maps': { body: MapCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /gis/maps/:id': { params: IdParam, response: { 200: MapRecord } },
  'PATCH /gis/maps/:id': { params: IdParam, body: MapUpdateInput, response: { 200: MapRecord } },
  'GET /gis/service-layers': { response: { 200: ServiceLayerList } },
  'POST /gis/service-layers': {
    body: ServiceLayerCreateInput,
    response: { 200: ServiceLayerRecord },
  },
  'GET /gis/service-layers/:id': { params: IdParam, response: { 200: ServiceLayerRecord } },
  'PATCH /gis/service-layers/:id': {
    params: IdParam,
    body: ServiceLayerUpdateInput,
    response: { 200: ServiceLayerRecord },
  },
  'POST /gis/service-layers/:id/check': {
    params: IdParam,
    response: { 200: ServiceLayerCheckResult },
  },
  'GET /gis/service-layers/:id/tiles/:z/:x/:y': { params: TileParams },
  'GET /gis/service-layers/:id/features': {
    params: IdParam,
    query: ServiceLayerFeaturesQuery,
    response: { 200: ServiceLayerFeatureCollection },
  },
  'POST /gis/service-layers/:id/import': {
    params: IdParam,
    body: ServiceLayerImportInput,
    response: { 200: ServiceLayerImportStarted },
  },
})
