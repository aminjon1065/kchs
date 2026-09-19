import {
  CorrespondentInput,
  CorrespondentList,
  CorrespondentListQuery,
  CorrespondentRecord,
  CorrespondentUpdateInput,
  DocumentCancelInput,
  DocumentCreateInput,
  DocumentPdfResult,
  DocumentRecord,
  DocumentRegisterInput,
  DocumentSummary,
  DocumentTypeCreateInput,
  DocumentTypeRecord,
  DocumentTypeUpdateInput,
  DocumentUpdateInput,
  DocumentVersionInput,
  DocumentVersionList,
  DocumentVersionRecord,
  JournalCreateInput,
  JournalRecord,
  JournalReservation,
  JournalReservationList,
  JournalReservationState,
  JournalReserveInput,
  JournalUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { CorrespondentService } from '../domain/correspondent-service.js'
import { DocumentService } from '../domain/document-service.js'
import { JournalService } from '../domain/journal-service.js'
import { DocumentTypeService } from '../domain/type-service.js'
import { DocumentVersionService } from '../domain/version-service.js'

const IdParam = z.object({ id: z.uuid() })
const Ok = z.object({ ok: z.boolean() })

/**
 * Документооборот (08-documents.md, 16-api-and-events.md §1): документы,
 * версии, регистрация и аннулирование, журналы с резервом номеров, типы и
 * корреспонденты. Каждый обработчик проверяет права через `authorize` ядра.
 */
export function registerDocumentRoutes(route: RouteRegistrar): void {
  // ─── Документы ────────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/documents/summary',
    auth: 'session',
    tags: ['documents'],
    summary: 'Счётчики навигатора: мои, на контроле, просроченные, черновики',
    schema: { response: { 200: DocumentSummary } },
    handler: async (request) => DocumentService.summary(request.ctx),
  })

  route({
    method: 'POST',
    url: '/documents',
    auth: 'session',
    tags: ['documents'],
    summary: 'Создать черновик документа по типу',
    schema: { body: DocumentCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/documents/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Карточка документа: реквизиты, регистрация, текущая версия, права',
    schema: { params: IdParam, response: { 200: DocumentRecord } },
    handler: async (request) => DocumentService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/documents/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить карточку: реквизиты, поля типа, участники, гриф',
    schema: { params: IdParam, body: DocumentUpdateInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/register',
    auth: 'session',
    tags: ['documents'],
    summary: 'Зарегистрировать документ: номер из журнала или резерва',
    schema: { params: IdParam, body: DocumentRegisterInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.register(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/cancel',
    auth: 'session',
    tags: ['documents'],
    summary: 'Аннулировать документ с обоснованием',
    schema: { params: IdParam, body: DocumentCancelInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.cancel(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/documents/:id/versions',
    auth: 'session',
    tags: ['documents'],
    summary: 'Версии документа: основной файл, приложения, PDF-представление',
    schema: { params: IdParam, response: { 200: DocumentVersionList } },
    handler: async (request) => ({
      items: await DocumentVersionService.list(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/documents/:id/versions',
    auth: 'session',
    tags: ['documents'],
    summary: 'Новая версия документа из прикреплённых файлов',
    schema: {
      params: IdParam,
      body: DocumentVersionInput,
      response: { 200: DocumentVersionRecord },
    },
    handler: async (request) => {
      const versionId = await db().transaction((tx) =>
        DocumentVersionService.add(tx, request.ctx, request.params.id, request.body),
      )
      const record = await DocumentVersionService.record(db(), versionId)
      if (!record) throw errors.internal('Версия создана, но не читается')
      return record
    },
  })

  route({
    method: 'POST',
    url: '/internal/documents/versions/:id/pdf',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок сообщает хэш версии и её PDF-представление',
    schema: {
      params: IdParam,
      body: DocumentPdfResult,
      response: { 200: z.object({ ok: z.boolean(), stale: z.boolean() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      const { stale } = await DocumentVersionService.applyPdfResult(request.params.id, request.body)
      return { ok: true, stale }
    },
  })

  // ─── Типы документов ──────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/document-types',
    auth: 'session',
    tags: ['documents'],
    summary: 'Типы документов',
    schema: {
      querystring: z.object({ includeInactive: z.coerce.boolean().default(false) }),
      response: { 200: z.object({ items: z.array(DocumentTypeRecord) }) },
    },
    handler: async (request) => ({
      items: await DocumentTypeService.list(request.ctx, {
        includeInactive: request.query.includeInactive,
      }),
    }),
  })

  route({
    method: 'GET',
    url: '/document-types/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Тип документа',
    schema: { params: IdParam, response: { 200: DocumentTypeRecord } },
    handler: async (request) => DocumentTypeService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/document-types',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать тип документа',
    schema: { body: DocumentTypeCreateInput, response: { 200: DocumentTypeRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentTypeService.create(tx, request.ctx, request.body),
      )
      return DocumentTypeService.get(request.ctx, id)
    },
  })

  route({
    method: 'PATCH',
    url: '/document-types/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить тип документа',
    schema: {
      params: IdParam,
      body: DocumentTypeUpdateInput,
      response: { 200: DocumentTypeRecord },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTypeService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTypeService.get(request.ctx, request.params.id)
    },
  })

  // ─── Журналы ──────────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/journals',
    auth: 'session',
    tags: ['documents'],
    summary: 'Журналы регистрации, доступные пользователю',
    schema: {
      querystring: z.object({ includeInactive: z.coerce.boolean().default(false) }),
      response: { 200: z.object({ items: z.array(JournalRecord) }) },
    },
    handler: async (request) => ({
      items: await JournalService.list(request.ctx, {
        includeInactive: request.query.includeInactive,
      }),
    }),
  })

  route({
    method: 'GET',
    url: '/journals/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Журнал регистрации: счётчик, следующий номер, резервы',
    schema: { params: IdParam, response: { 200: JournalRecord } },
    handler: async (request) => JournalService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/journals',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать журнал регистрации',
    schema: { body: JournalCreateInput, response: { 200: JournalRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        JournalService.create(tx, request.ctx, request.body),
      )
      return JournalService.get(request.ctx, id)
    },
  })

  route({
    method: 'PATCH',
    url: '/journals/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить журнал регистрации',
    schema: { params: IdParam, body: JournalUpdateInput, response: { 200: JournalRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        JournalService.update(tx, request.ctx, request.params.id, request.body),
      )
      return JournalService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/journals/:id/reservations',
    auth: 'session',
    tags: ['documents'],
    summary: 'Зарезервированные номера журнала',
    schema: {
      params: IdParam,
      querystring: z.object({ state: JournalReservationState.optional() }),
      response: { 200: JournalReservationList },
    },
    handler: async (request) => ({
      items: await JournalService.reservations(request.ctx, request.params.id, request.query.state),
    }),
  })

  route({
    method: 'POST',
    url: '/journals/:id/reservations',
    auth: 'session',
    tags: ['documents'],
    summary: 'Зарезервировать номера для бумажных документов',
    schema: {
      params: IdParam,
      body: JournalReserveInput,
      response: { 200: z.object({ items: z.array(JournalReservation) }) },
    },
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        JournalService.reserve(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    method: 'DELETE',
    url: '/journals/:id/reservations/:reservationId',
    auth: 'session',
    tags: ['documents'],
    summary: 'Снять резерв номера',
    schema: {
      params: z.object({ id: z.uuid(), reservationId: z.uuid() }),
      response: { 200: Ok },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        JournalService.cancelReservation(
          tx,
          request.ctx,
          request.params.id,
          request.params.reservationId,
        ),
      )
      return { ok: true }
    },
  })

  // ─── Корреспонденты ───────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/correspondents',
    auth: 'session',
    tags: ['documents'],
    summary: 'Корреспонденты: поиск по названию и реквизитам',
    schema: { querystring: CorrespondentListQuery, response: { 200: CorrespondentList } },
    handler: async (request) => CorrespondentService.list(request.ctx, request.query),
  })

  route({
    method: 'GET',
    url: '/correspondents/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Корреспондент',
    schema: { params: IdParam, response: { 200: CorrespondentRecord } },
    handler: async (request) => CorrespondentService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/correspondents',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Создать корреспондента',
    schema: { body: CorrespondentInput, response: { 200: CorrespondentRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        CorrespondentService.create(tx, request.ctx, request.body),
      )
      return CorrespondentService.get(request.ctx, id)
    },
  })

  route({
    method: 'PATCH',
    url: '/correspondents/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить корреспондента',
    schema: {
      params: IdParam,
      body: CorrespondentUpdateInput,
      response: { 200: CorrespondentRecord },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        CorrespondentService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CorrespondentService.get(request.ctx, request.params.id)
    },
  })
}
