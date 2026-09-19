import { NotebookCellsInput, NotebookCreateInput, NotebookRecord } from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { registerCollabType } from '~/kernel/collab/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { registerObjectType } from '~/kernel/objects/registry.js'
import { indexObject } from '~/kernel/search/index-service.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { NotebookService } from './domain/notebook-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Тетради модуля «Данные» (P2-E05 S02, 06-analytics-engine.md §11): тип
 * объекта, совместный документ (ADR-0070/0071), маршруты и индексация снимка.
 */
export function registerNotebookType(): void {
  registerObjectType({
    type: 'notebook',
    labelKey: 'objects.types.notebook',
    icon: 'notebook',
    route: (id) => `/o/${id}`,
    levels: ['view', 'comment', 'edit', 'manage', 'owner'],
    actions: {
      view: { minLevel: 'view' },
      comment: { minLevel: 'comment' },
      /** Правка документа: подключение к нему не только для чтения. */
      edit: { minLevel: 'edit' },
      manage: { minLevel: 'manage' },
      share: { minLevel: 'manage' },
      delete: { minLevel: 'manage' },
    },
    discussable: true,
    linkable: true,
    hasParentTree: true,
    searchable: (id) => NotebookService.searchable(id),
  })

  registerCollabType({
    type: 'notebook',
    initialState: (id, executor) => NotebookService.initialState(id, executor),
    snapshot: (tx, ctx, id, doc) => NotebookService.snapshot(tx, ctx, id, doc),
  })
}

export function registerNotebookRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/notebooks',
    auth: 'session',
    tags: ['data'],
    summary: 'Создать тетрадь',
    description:
      'Ячейки и параметры — начальное содержимое; дальше тетрадь правится совместно (/collab).',
    schema: { body: NotebookCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        NotebookService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/notebooks/:id',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Тетрадь: снимок ячеек и параметров',
    description:
      'Снимок совместного документа: отстаёт от открытой тетради не больше чем на 10 с (ADR-0070).',
    schema: { params: IdParam, response: { 200: NotebookRecord } },
    handler: async (request) => NotebookService.get(request.params.id),
  })

  route({
    method: 'POST',
    url: '/notebooks/:id/cells',
    auth: { action: 'edit' },
    tags: ['data'],
    summary: 'Добавить ячейки в тетрадь',
    description: 'Ячейки сразу появляются у всех, кто открыл тетрадь.',
    schema: { params: IdParam, body: NotebookCellsInput, response: { 200: NotebookRecord } },
    handler: async (request) =>
      NotebookService.addCells(request.ctx, request.params.id, request.body),
  })
}

/** Снимок тетради изменился — её текст в поиске тоже. */
export function registerNotebookBackground(): void {
  registerSubscriber({
    name: 'data-notebook-search',
    types: ['notebook.updated'],
    handle: async (event) => {
      if (event.object) await indexObject(event.object.id)
    },
  })
}
