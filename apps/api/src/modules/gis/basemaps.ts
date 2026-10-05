import { registerObjectType } from '~/kernel/objects/registry.js'
import { errors } from '~/shared/errors.js'
import { rateLimit } from '~/shared/http/rate-limit.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { BasemapService } from './domain/basemap-service.js'
import { readGlyphs, readSprite } from './domain/basemap-storage.js'
import { GisRenderSettingsService } from './domain/render-settings.js'

const MANAGE = 'gis.basemaps.manage'
/** Карта запрашивает диапазоны архива и тайлы пачками — лимит как у тайлов слоёв. */
const TILES_PER_MINUTE = 6000
/** Шрифты и спрайты меняются только с новой сборкой. */
const ASSET_CACHE_CONTROL = 'private, max-age=86400'

/**
 * Базовая карта — объект реестра (ADR-0066): глобальный, без пространства и
 * владельца, виден всем сотрудникам; управление — действие `manage` со
 * способностью `gis.basemaps.manage` (модель ролей, без проверок ролей в модуле).
 */
export function registerBasemapObjectType(): void {
  registerObjectType({
    type: 'basemap',
    labelKey: 'objects.types.basemap',
    icon: 'map',
    route: (id) => `/o/${id}`,
    levels: ['view', 'manage'],
    actions: {
      view: { minLevel: 'view' },
      manage: { minLevel: 'view', capability: MANAGE },
    },
    // Поиск — по названию из реестра: кто видит подложку, тот её и находит
    discussable: false,
    linkable: false,
    hasParentTree: false,
  })
}

export function registerBasemapRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /gis/render-settings',
    auth: 'session',
    tags: ['gis'],
    summary: 'Отрисовка больших слоёв: порог deck.gl в карте-студии (ADR-0110)',
    handler: async () => GisRenderSettingsService.current(),
  })

  route({
    route: 'PUT /admin/gis/render-settings',
    auth: { capability: MANAGE },
    tags: ['gis'],
    summary: 'Изменить порог отрисовки больших слоёв',
    handler: async (request) => GisRenderSettingsService.update(request.ctx, request.body),
  })

  route({
    route: 'GET /gis/basemaps',
    auth: 'session',
    tags: ['gis'],
    summary: 'Базовые карты установки: по умолчанию первой',
    handler: async (request) => {
      if (request.ctx.shareLink) throw errors.forbidden()
      return { items: await BasemapService.list(request.ctx) }
    },
  })

  route({
    route: 'POST /gis/basemaps',
    auth: { capability: MANAGE },
    tags: ['gis'],
    summary: 'Добавить растровую XYZ-подложку (ключ доступа хранится отдельно)',
    handler: async (request) => BasemapService.create(request.ctx, request.body),
  })

  route({
    route: 'GET /gis/basemaps/:id',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Базовая карта',
    handler: async (request) => BasemapService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /gis/basemaps/:id',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Изменить базовую карту: название; у растровой — адрес, ключ, масштабы',
    handler: async (request) => BasemapService.update(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'DELETE /gis/basemaps/:id',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Удалить базовую карту (кроме «без подложки» и подложки по умолчанию)',
    handler: async (request) => {
      await BasemapService.remove(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'POST /gis/basemaps/:id/default',
    auth: { action: 'manage' },
    tags: ['gis'],
    summary: 'Сделать базовой картой по умолчанию',
    handler: async (request) => {
      await BasemapService.setDefault(request.ctx, request.params.id)
      return { ok: true }
    },
  })

  route({
    route: 'GET /gis/basemaps/:id/style.json',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Стиль MapLibre темы light/dark/muted с абсолютными адресами через API',
    handler: async (request, reply) => {
      const style = await BasemapService.style(request.params.id, request.query)
      reply.header('cache-control', 'private, max-age=300')
      return style
    },
  })

  route({
    route: 'GET /gis/basemaps/:id/pmtiles/:file',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Архив PMTiles векторной подложки диапазонами байтов (Range → 206)',
    rateLimit: rateLimit(TILES_PER_MINUTE, '1 minute'),
    handler: async (request, reply) => {
      const range = request.headers.range
      const archive = await BasemapService.archive(
        request.params.id,
        request.params.file,
        typeof range === 'string' ? range : undefined,
      )
      reply.code(archive.status).headers(archive.headers)
      return reply.send(archive.body ?? '')
    },
  })

  route({
    route: 'GET /gis/basemaps/:id/tiles/:z/:x/:y',
    auth: { action: 'view' },
    tags: ['gis'],
    summary: 'Растровый тайл через прокси API: ключ сервера скрыт, тайлы в кэше',
    rateLimit: rateLimit(TILES_PER_MINUTE, '1 minute'),
    handler: async (request, reply) => {
      const { id, z: zoom, x, y } = request.params
      const tile = await BasemapService.rasterTile(id, zoom, x, y)
      if (!tile) return reply.code(404).send()
      reply
        .header('content-type', tile.contentType)
        // Адрес стиля несёт метку адреса сервера: смена адреса — новые тайлы
        .header('cache-control', 'private, max-age=86400')
      return reply.send(tile.body)
    },
  })

  route({
    route: 'GET /gis/glyphs/:fontstack/:range',
    auth: { open: 'шрифты подписей карты — общие файлы оформления' },
    tags: ['gis'],
    summary: 'Шрифты подписей карты (PBF, кириллица) из хранилища установки',
    handler: async (request, reply) => {
      const range = request.params.range.replace(/\.pbf$/, '')
      const glyphs = await readGlyphs(request.params.fontstack, range)
      if (!glyphs) throw errors.notFound('Шрифт')
      reply
        .header('content-type', 'application/x-protobuf')
        .header('cache-control', ASSET_CACHE_CONTROL)
      return reply.send(glyphs)
    },
  })

  route({
    route: 'GET /gis/sprites/:file',
    auth: { open: 'значки подложки карты — общие файлы оформления' },
    tags: ['gis'],
    summary: 'Спрайт подложки темы: значки населённых пунктов и вершин',
    handler: async (request, reply) => {
      const sprite = await readSprite(request.params.file)
      if (!sprite) throw errors.notFound('Спрайт')
      reply
        .header(
          'content-type',
          request.params.file.endsWith('.png') ? 'image/png' : 'application/json',
        )
        .header('cache-control', ASSET_CACHE_CONTROL)
      return reply.send(sprite)
    },
  })
}
