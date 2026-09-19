import {
  DocumentFillInput,
  DocumentFromTemplateInput,
  DocumentFromTemplateResult,
  DocumentRenderRecord,
  DocumentTemplateCreateInput,
  DocumentTemplateFileInput,
  DocumentTemplateList,
  DocumentTemplateListQuery,
  DocumentTemplateRecord,
  DocumentTemplateUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DocumentRenders } from '../domain/render-service.js'
import { DocumentTemplateService } from '../domain/template-service.js'

const IdParam = z.object({ id: z.uuid() })

/** Шаблоны DOCX и «Создать по шаблону» (08-documents.md §8, ADR-0085). */
export function registerTemplateRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/document-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Шаблоны документов: все или подходящие типу',
    schema: { querystring: DocumentTemplateListQuery, response: { 200: DocumentTemplateList } },
    handler: async (request) => ({
      items: await DocumentTemplateService.list(request.ctx, request.query),
    }),
  })

  route({
    method: 'GET',
    url: '/document-templates/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Шаблон документа: файл, плейсхолдеры, карточка по умолчанию',
    schema: { params: IdParam, response: { 200: DocumentTemplateRecord } },
    handler: async (request) => DocumentTemplateService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/document-templates',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать шаблон документа (файл — следующим шагом)',
    schema: { body: DocumentTemplateCreateInput, response: { 200: DocumentTemplateRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentTemplateService.create(tx, request.ctx, request.body),
      )
      return DocumentTemplateService.get(request.ctx, id)
    },
  })

  route({
    method: 'PATCH',
    url: '/document-templates/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить шаблон: название, тип, карточку по умолчанию, использование',
    schema: {
      params: IdParam,
      body: DocumentTemplateUpdateInput,
      response: { 200: DocumentTemplateRecord },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTemplateService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTemplateService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/document-templates/:id/file',
    auth: 'session',
    tags: ['documents'],
    summary: 'Файл шаблона (DOCX, загруженный вложением): движок разберёт плейсхолдеры',
    schema: {
      params: IdParam,
      body: DocumentTemplateFileInput,
      response: { 200: DocumentTemplateRecord },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTemplateService.setFile(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTemplateService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/from-template',
    auth: 'session',
    tags: ['documents'],
    summary: 'Создать документ по шаблону: черновик и первая версия от движка',
    schema: { body: DocumentFromTemplateInput, response: { 200: DocumentFromTemplateResult } },
    handler: async (request) =>
      db().transaction((tx) =>
        DocumentTemplateService.createDocument(tx, request.ctx, request.body),
      ),
  })

  route({
    method: 'POST',
    url: '/documents/:id/fill',
    auth: 'session',
    tags: ['documents'],
    summary: 'Заполнить документ по шаблону из текущей карточки — новая версия',
    schema: { params: IdParam, body: DocumentFillInput, response: { 200: DocumentRenderRecord } },
    handler: async (request) => {
      const renderId = await db().transaction((tx) =>
        DocumentTemplateService.fill(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentRenders.get(request.ctx, renderId)
    },
  })
}
