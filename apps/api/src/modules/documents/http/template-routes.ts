import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentRenders } from '../domain/render-service.js'
import { DocumentTemplateService } from '../domain/template-service.js'

/** Шаблоны DOCX и «Создать по шаблону» (08-documents.md §8, ADR-0085). */
export function registerTemplateRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /document-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Шаблоны документов: все или подходящие типу',
    handler: async (request) => ({
      items: await DocumentTemplateService.list(request.ctx, request.query),
    }),
  })

  route({
    route: 'GET /document-templates/:id',
    auth: { delegated: 'DocumentTemplateService.get', objectType: 'template' },
    tags: ['documents'],
    summary: 'Шаблон документа: файл, плейсхолдеры, карточка по умолчанию',
    handler: async (request) => DocumentTemplateService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /document-templates',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать шаблон документа (файл — следующим шагом)',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentTemplateService.create(tx, request.ctx, request.body),
      )
      return DocumentTemplateService.get(request.ctx, id)
    },
  })

  route({
    route: 'PATCH /document-templates/:id',
    auth: { delegated: 'DocumentTemplateService.update', objectType: 'template' },
    tags: ['documents'],
    summary: 'Изменить шаблон: название, тип, карточку по умолчанию, использование',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTemplateService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTemplateService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /document-templates/:id/file',
    auth: { delegated: 'DocumentTemplateService.setFile', objectType: 'template' },
    tags: ['documents'],
    summary: 'Файл шаблона (DOCX, загруженный вложением): движок разберёт плейсхолдеры',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTemplateService.setFile(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTemplateService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /documents/from-template',
    auth: 'session',
    tags: ['documents'],
    summary: 'Создать документ по шаблону: черновик и первая версия от движка',
    handler: async (request) =>
      db().transaction((tx) =>
        DocumentTemplateService.createDocument(tx, request.ctx, request.body),
      ),
  })

  route({
    route: 'POST /documents/:id/fill',
    auth: { delegated: 'DocumentTemplateService.fill', objectType: 'document' },
    tags: ['documents'],
    summary: 'Заполнить документ по шаблону из текущей карточки — новая версия',
    handler: async (request) => {
      const renderId = await db().transaction((tx) =>
        DocumentTemplateService.fill(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentRenders.get(request.ctx, renderId)
    },
  })
}
