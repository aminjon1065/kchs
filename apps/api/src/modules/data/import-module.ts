import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DatasetAccess } from './domain/dataset-access.js'
import { DatasetService } from './domain/dataset-service.js'
import { ImportService } from './domain/import-service.js'

/**
 * Импорт файлов в датасет (ADR-0046): разбор, загрузка, публикация, отмена и итог
 * нормализации от движка.
 */
export function registerImportRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /datasets/:id/imports',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Импорты датасета (сводки изменений — без примеров)',
    handler: async (request) => ({
      items: (await ImportService.list(request.params.id)).map(ImportService.withoutSamples),
    }),
  })

  route({
    route: 'POST /datasets/imports/analyze',
    auth: 'session',
    tags: ['data'],
    summary: 'Анализ файла для импорта: формат, типы, семантика, предпросмотр',
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.body.fileId)
      return ImportService.analyze(request.body)
    },
  })

  route({
    route: 'POST /datasets/imports',
    auth: 'session',
    tags: ['data'],
    summary: 'Запустить импорт файла в новый или существующий датасет',
    handler: async (request) => {
      const { target } = request.body
      await authorize(request.ctx, 'view', request.body.fileId)
      if (target.kind === 'new') {
        await authorize(request.ctx, 'create_child', target.parentId ?? target.spaceId)
      } else {
        await authorize(request.ctx, 'import', target.datasetId)
      }
      return db().transaction((tx) => ImportService.start(tx, request.ctx, request.body))
    },
  })

  route({
    route: 'GET /datasets/imports/:id',
    auth: { delegated: 'ImportService.get → DatasetAccess.resolve', resource: 'import' },
    tags: ['data'],
    summary: 'Состояние импорта; сводка изменений — с политиками пользователя (ADR-0068)',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      const grant = await DatasetAccess.resolve(request.ctx, record.datasetId, 'view')
      const canImport = (await authorize(request.ctx, 'import', record.datasetId, { soft: true }))
        .allowed
      const { primaryKey } = await DatasetService.storage(record.datasetId)
      return ImportService.visible(record, grant, canImport, primaryKey)
    },
  })

  route({
    route: 'POST /datasets/imports/:id/publish',
    auth: { delegated: 'authorize(import)', resource: 'import' },
    tags: ['data'],
    summary: 'Опубликовать импорт после предпросмотра изменений: загрузка в датасет',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      await authorize(request.ctx, 'import', record.datasetId)
      return ImportService.withoutSamples(
        await ImportService.publish(request.ctx, request.params.id),
      )
    },
  })

  route({
    route: 'POST /datasets/imports/:id/cancel',
    auth: { delegated: 'authorize(import)', resource: 'import' },
    tags: ['data'],
    summary: 'Отменить импорт после предпросмотра изменений: датасет не меняется',
    handler: async (request) => {
      const record = await ImportService.get(request.params.id)
      await authorize(request.ctx, 'import', record.datasetId)
      return ImportService.withoutSamples(
        await ImportService.cancel(request.ctx, request.params.id),
      )
    },
  })

  route({
    route: 'POST /internal/data/imports/:id/normalized',
    auth: { engineJob: { scope: (params) => `import:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок сообщает итог нормализации файла импорта (ADR-0046)',
    handler: async (request) => ({
      loadJobId: await ImportService.acceptNormalized(request.params.id, request.body),
    }),
  })
}
