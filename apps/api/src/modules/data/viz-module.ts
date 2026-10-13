import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ChartService, runChartSpec } from './domain/chart-service.js'
import { DashboardService } from './domain/dashboard-service.js'
import { MetricService } from './domain/metric-service.js'
import { systemDatasetSchema } from './domain/system-schema.js'

/**
 * Графики, дашборды и показатели (06-analytics-engine.md): данные считаются с политиками
 * смотрящего; системные датасеты платформы.
 */
export function registerVisualizationRoutes(route: RouteRegistrar): void {
  route({
    route: 'POST /charts',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать график',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => ChartService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /charts/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'График: спецификация',
    handler: async (request) => ChartService.get(request.params.id),
  })

  route({
    route: 'PATCH /charts/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить график: название, спецификация',
    handler: async (request) => {
      await db().transaction((tx) =>
        ChartService.update(tx, request.ctx, request.params.id, request.body),
      )
      return ChartService.get(request.params.id)
    },
  })

  route({
    route: 'POST /charts/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные графика — с политиками пользователя',
    readOnly: true,
    handler: async (request) => {
      const chart = await ChartService.get(request.params.id)
      return runChartSpec(request.ctx, chart.spec, {
        ...chart.paramsDefaults,
        ...request.body.params,
      })
    },
  })

  route({
    route: 'POST /dashboards',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать дашборд',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        DashboardService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /dashboards/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Дашборд: плитки и фильтры',
    handler: async (request) => DashboardService.get(request.params.id),
  })

  route({
    route: 'PATCH /dashboards/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить дашборд: название, плитки, фильтры',
    handler: async (request) => {
      await db().transaction((tx) =>
        DashboardService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DashboardService.get(request.params.id)
    },
  })

  route({
    route: 'POST /dashboards/:id/data',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Данные плиток дашборда одним запросом, с фильтрами дашборда',
    // Чтение: доступно и странице печати отчёта с токеном печати (блок «Дашборд», ADR-0164)
    readOnly: true,
    handler: async (request) => DashboardService.data(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /dashboards/:id/drill',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Детализация плитки до строк: выбранный элемент графика и фильтры дашборда',
    handler: async (request) =>
      DashboardService.drill(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /system-datasets/:name',
    auth: { open: 'имя системного датасета — справочник полей; строки — по политикам датасета' },
    tags: ['data'],
    summary: 'Схема системного датасета: поля для подписей показателей (ADR-0082)',
    handler: async (request) => systemDatasetSchema(request.ctx, request.params.name),
  })

  route({
    route: 'POST /metrics',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать показатель',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) => MetricService.create(tx, request.ctx, request.body))
      return { id }
    },
  })

  route({
    route: 'GET /metrics/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Показатель: определение, цели, пороги',
    handler: async (request) => MetricService.get(request.params.id),
  })

  route({
    route: 'PATCH /metrics/:id',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Изменить показатель',
    handler: async (request) => {
      await db().transaction((tx) =>
        MetricService.update(tx, request.ctx, request.params.id, request.body),
      )
      return MetricService.get(request.params.id)
    },
  })

  route({
    route: 'POST /metrics/:id/value',
    auth: { action: 'view' },
    tags: ['data'],
    summary:
      'Значение показателя: сравнение, статус порога, история и разрез — с политиками пользователя',
    readOnly: true,
    handler: async (request) =>
      MetricService.evaluate(request.ctx, await MetricService.get(request.params.id), request.body),
  })
}
