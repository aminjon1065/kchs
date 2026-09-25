import {
  AcknowledgmentRequestInput,
  AcknowledgmentRequestResult,
  CaseCloseYearInput,
  CaseCreateInput,
  CaseImportInput,
  CaseImportReport,
  CaseList,
  CaseListQuery,
  CaseRecord,
  CaseSuggestions,
  CaseSuggestionsQuery,
  CaseUpdateInput,
  CorrespondenceChain,
  CorrespondentInput,
  CorrespondentList,
  CorrespondentListQuery,
  CorrespondentRecord,
  CorrespondentUpdateInput,
  DestructionActInput,
  DestructionActList,
  DocumentBulkInput,
  DocumentBulkResult,
  DocumentCancelInput,
  DocumentCreateInput,
  DocumentDispatchInput,
  DocumentDispatchList,
  DocumentEmailInput,
  DocumentEmailList,
  DocumentFileInput,
  DocumentMailStatus,
  DocumentNumberPreview,
  DocumentNumberPreviewQuery,
  DocumentPdfResult,
  DocumentRecord,
  DocumentRegisterInput,
  DocumentRegistryQuery,
  DocumentReplyInput,
  DocumentResolutions,
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
  NoExecutionInput,
  ResolutionInput,
  ResolutionRequestInput,
  ResolutionTemplate,
  ResolutionTemplateInput,
  ResolutionTemplateUpdateInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { DocumentAcknowledgments } from '../domain/acknowledgment-service.js'
import { DocumentBulk } from '../domain/bulk-service.js'
import { CaseImport } from '../domain/case-import.js'
import { CaseService } from '../domain/case-service.js'
import { Correspondence } from '../domain/correspondence-service.js'
import { CorrespondentService } from '../domain/correspondent-service.js'
import { DocumentService } from '../domain/document-service.js'
import { JournalService } from '../domain/journal-service.js'
import { DocumentMailOut } from '../domain/mail-out.js'
import { officeDashboardId } from '../domain/office-dashboard.js'
import { ResolutionService } from '../domain/resolution-service.js'
import { ResolutionTemplates } from '../domain/resolution-templates.js'
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
    method: 'GET',
    url: '/documents/office',
    auth: 'session',
    tags: ['documents'],
    summary: 'Дашборд «Канцелярия», если он заведён и виден пользователю',
    schema: { response: { 200: z.object({ dashboardId: z.uuid().nullable() }) } },
    handler: async (request) => ({ dashboardId: await officeDashboardId(request.ctx) }),
  })

  // ─── Массовые действия в списке (ADR-0152) ─────────────────────────────────
  route({
    method: 'POST',
    url: '/documents/bulk',
    auth: 'session',
    tags: ['documents'],
    summary: 'Массовое действие над выбранными документами: подшить в дело, на ознакомление',
    description:
      'Права и состояние проверяются по каждому документу; отказ по одному не отменяет остальных.',
    schema: { body: DocumentBulkInput, response: { 200: DocumentBulkResult } },
    handler: async (request) => DocumentBulk.run(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/documents/registry.xlsx',
    auth: 'session',
    tags: ['documents'],
    summary: 'Реестр выбранных документов в Excel',
    schema: { querystring: DocumentRegistryQuery },
    handler: async (request, reply) => {
      const content = await DocumentBulk.registry(request.ctx, request.query.ids)
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="kchs-documents.xlsx"')
      return reply.send(content)
    },
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
    method: 'GET',
    url: '/documents/:id/number-preview',
    auth: 'session',
    tags: ['documents'],
    summary: 'Каким будет номер при регистрации: журнал и дело по номенклатуре, без выдачи',
    schema: {
      params: IdParam,
      querystring: DocumentNumberPreviewQuery,
      response: { 200: DocumentNumberPreview },
    },
    handler: async (request) =>
      DocumentService.previewNumber(request.ctx, request.params.id, request.query),
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

  // ─── Резолюции и исполнение (ADR-0084) ────────────────────────────────────
  route({
    method: 'GET',
    url: '/documents/:id/resolutions',
    auth: 'session',
    tags: ['documents'],
    summary: 'Резолюции документа деревом, направления на резолюцию, права смотрящего',
    schema: { params: IdParam, response: { 200: DocumentResolutions } },
    handler: async (request) => ResolutionService.list(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/:id/resolutions',
    auth: 'session',
    tags: ['documents'],
    summary: 'Наложить резолюцию: поручения ответственному и соисполнителям в той же транзакции',
    schema: { params: IdParam, body: ResolutionInput, response: { 200: DocumentResolutions } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.create(tx, request.ctx, request.params.id, request.body),
      )
      return ResolutionService.list(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/resolution-requests',
    auth: 'session',
    tags: ['documents'],
    summary: 'Направить документ на резолюцию (или переадресовать)',
    schema: {
      params: IdParam,
      body: ResolutionRequestInput,
      response: { 200: DocumentResolutions },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.request(tx, request.ctx, request.params.id, request.body),
      )
      return ResolutionService.list(request.ctx, request.params.id)
    },
  })

  route({
    method: 'DELETE',
    url: '/documents/:id/resolution-requests/:requestId',
    auth: 'session',
    tags: ['documents'],
    summary: 'Снять направление на резолюцию',
    schema: {
      params: z.object({ id: z.uuid(), requestId: z.uuid() }),
      response: { 200: DocumentResolutions },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.cancelRequest(
          tx,
          request.ctx,
          request.params.id,
          request.params.requestId,
        ),
      )
      return ResolutionService.list(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/no-execution',
    auth: 'session',
    tags: ['documents'],
    summary: '«Не требует исполнения»: зарегистрированный документ исполнен без поручений',
    schema: { params: IdParam, body: NoExecutionInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.noExecution(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/acknowledgments',
    auth: 'session',
    tags: ['documents'],
    summary: 'Отправить на ознакомление: сотрудники, подразделения, группы',
    schema: {
      params: IdParam,
      body: AcknowledgmentRequestInput,
      response: { 200: AcknowledgmentRequestResult },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        DocumentAcknowledgments.request(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    method: 'GET',
    url: '/resolution-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Шаблоны резолюций: общие и личные',
    schema: { response: { 200: z.object({ items: z.array(ResolutionTemplate) }) } },
    handler: async (request) => ({ items: await ResolutionTemplates.list(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/resolution-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Новый шаблон резолюции (общий — канцелярия)',
    schema: {
      body: ResolutionTemplateInput,
      response: { 200: z.object({ items: z.array(ResolutionTemplate) }) },
    },
    handler: async (request) => {
      await db().transaction((tx) => ResolutionTemplates.create(tx, request.ctx, request.body))
      return { items: await ResolutionTemplates.list(request.ctx) }
    },
  })

  route({
    method: 'PATCH',
    url: '/resolution-templates/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить шаблон резолюции',
    schema: {
      params: IdParam,
      body: ResolutionTemplateUpdateInput,
      response: { 200: ResolutionTemplate },
    },
    handler: async (request) =>
      db().transaction((tx) =>
        ResolutionTemplates.update(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    method: 'DELETE',
    url: '/resolution-templates/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Удалить шаблон резолюции',
    schema: { params: IdParam, response: { 200: Ok } },
    handler: async (request) => {
      await db().transaction((tx) => ResolutionTemplates.remove(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })

  // ─── Переписка и дела (ADR-0086) ──────────────────────────────────────────
  route({
    method: 'POST',
    url: '/documents/:id/reply',
    auth: 'session',
    tags: ['documents'],
    summary: 'Ответить на входящий: исходящий черновик со связью «в ответ на»',
    schema: {
      params: IdParam,
      body: DocumentReplyInput,
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        Correspondence.reply(tx, request.ctx, request.params.id, request.body),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/documents/:id/correspondence',
    auth: 'session',
    tags: ['documents'],
    summary: 'Цепочка переписки по связям «в ответ на»',
    schema: { params: IdParam, response: { 200: CorrespondenceChain } },
    handler: async (request) => Correspondence.chain(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/documents/:id/dispatches',
    auth: 'session',
    tags: ['documents'],
    summary: 'Отметки об отправке исходящего',
    schema: { params: IdParam, response: { 200: DocumentDispatchList } },
    handler: async (request) => ({
      items: await Correspondence.dispatches(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/documents/:id/dispatches',
    auth: 'session',
    tags: ['documents'],
    summary: 'Отметить отправку исходящего; первая отправка исполняет документ',
    schema: { params: IdParam, body: DocumentDispatchInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        Correspondence.dispatch(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/documents/mail-out/status',
    auth: 'session',
    tags: ['documents'],
    summary: 'Можно ли отправлять исходящие письмом и от чьего имени (ADR-0149)',
    schema: { response: { 200: DocumentMailStatus } },
    handler: async () => DocumentMailOut.status(),
  })

  route({
    method: 'GET',
    url: '/documents/:id/emails',
    auth: 'session',
    tags: ['documents'],
    summary: 'Письма исходящего: в очереди, отправленные, не ушедшие',
    schema: { params: IdParam, response: { 200: DocumentEmailList } },
    handler: async (request) => ({
      items: await DocumentMailOut.list(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/documents/:id/emails',
    auth: 'session',
    tags: ['documents'],
    summary: 'Отправить исходящий письмом из ящика канцелярии',
    description:
      'Письмо уходит заданием; отметка в реестре отправки появляется, когда почтовый сервер его принял.',
    schema: { params: IdParam, body: DocumentEmailInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentMailOut.queue(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/:id/emails/:emailId/retry',
    auth: 'session',
    tags: ['documents'],
    summary: 'Повторить письмо, которое не ушло или вернулось',
    schema: {
      params: z.object({ id: z.uuid(), emailId: z.uuid() }),
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => ({
      id: await db().transaction((tx) =>
        DocumentMailOut.retry(tx, request.ctx, request.params.id, request.params.emailId),
      ),
    }),
  })

  route({
    method: 'GET',
    url: '/documents/:id/cases',
    auth: 'session',
    tags: ['documents'],
    summary:
      'Открытые дела для подшивки документа или номера при регистрации — подходящие по типу и подразделению',
    schema: {
      params: IdParam,
      querystring: CaseSuggestionsQuery,
      response: { 200: CaseSuggestions },
    },
    handler: async (request) =>
      CaseService.suggest(request.ctx, request.params.id, request.query.purpose),
  })

  route({
    method: 'POST',
    url: '/documents/:id/file',
    auth: 'session',
    tags: ['documents'],
    summary: 'Подшить исполненный документ в дело',
    schema: { params: IdParam, body: DocumentFileInput, response: { 200: DocumentRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        CaseService.fileDocument(tx, request.ctx, request.params.id, request.body.caseId),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/cases',
    auth: 'session',
    tags: ['documents'],
    summary: 'Номенклатура дел: дела по годам, состоянию, подразделению',
    schema: { querystring: CaseListQuery, response: { 200: CaseList } },
    handler: async (request) => ({ items: await CaseService.list(request.ctx, request.query) }),
  })

  route({
    method: 'GET',
    url: '/cases/import/template.xlsx',
    auth: 'session',
    tags: ['documents'],
    summary: 'Образец импорта номенклатуры: типовая номенклатура, подразделения и типы документов',
    handler: async (request, reply) => {
      const content = await CaseImport.template(request.ctx)
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="kchs-nomenclature.xlsx"')
      return reply.send(content)
    },
  })

  route({
    method: 'POST',
    url: '/cases/import',
    auth: 'session',
    tags: ['documents'],
    summary: 'Проверить или импортировать номенклатуру дел из загруженного файла Excel',
    schema: { body: CaseImportInput, response: { 200: CaseImportReport } },
    handler: async (request) => CaseImport.run(request.ctx, request.body),
  })

  route({
    method: 'GET',
    url: '/cases/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Дело номенклатуры',
    schema: { params: IdParam, response: { 200: CaseRecord } },
    handler: async (request) => CaseService.get(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/cases',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Завести дело номенклатуры',
    schema: { body: CaseCreateInput, response: { 200: CaseRecord } },
    handler: async (request) => {
      const id = await db().transaction((tx) => CaseService.create(tx, request.ctx, request.body))
      return CaseService.get(request.ctx, id)
    },
  })

  route({
    method: 'PATCH',
    url: '/cases/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Изменить дело номенклатуры',
    schema: { params: IdParam, body: CaseUpdateInput, response: { 200: CaseRecord } },
    handler: async (request) => {
      await db().transaction((tx) =>
        CaseService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CaseService.get(request.ctx, request.params.id)
    },
  })

  for (const action of ['close', 'reopen', 'archive'] as const) {
    route({
      method: 'POST',
      url: `/cases/:id/${action}`,
      auth: 'session',
      tags: ['documents'],
      summary:
        action === 'close'
          ? 'Закрыть дело'
          : action === 'reopen'
            ? 'Вернуть закрытое дело в работу'
            : 'Передать закрытое дело в архив вместе с документами',
      schema: { params: IdParam, response: { 200: CaseRecord } },
      handler: async (request) => {
        await db().transaction(async (tx) => {
          await CaseService[action](tx, request.ctx, request.params.id)
        })
        return CaseService.get(request.ctx, request.params.id)
      },
    })
  }

  route({
    method: 'POST',
    url: '/cases/close-year',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Закрыть открытые дела года',
    schema: { body: CaseCloseYearInput, response: { 200: z.object({ closed: z.number() }) } },
    handler: async (request) => ({
      closed: await db().transaction((tx) =>
        CaseService.closeYear(tx, request.ctx, request.body.year),
      ),
    }),
  })

  route({
    method: 'GET',
    url: '/cases/destruction-acts',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Акты о выделении дел к уничтожению',
    schema: { response: { 200: DestructionActList } },
    handler: async (request) => ({ items: await CaseService.acts(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/cases/destruction-acts',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Акт о выделении к уничтожению: файлы дел удаляются, карточки остаются',
    schema: { body: DestructionActInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      const id = await db().transaction((tx) => CaseService.destroy(tx, request.ctx, request.body))
      return { id }
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
