import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
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
import { territoryDocuments } from '../domain/territory-documents.js'
import { DocumentTypeService } from '../domain/type-service.js'
import { DocumentVersionService } from '../domain/version-service.js'

/**
 * Документооборот (08-documents.md, 16-api-and-events.md §1): документы,
 * версии, регистрация и аннулирование, журналы с резервом номеров, типы и
 * корреспонденты. Каждый обработчик проверяет права через `authorize` ядра.
 */
export function registerDocumentRoutes(route: RouteRegistrar): void {
  // ─── Документы ────────────────────────────────────────────────────────────
  route({
    route: 'GET /documents/summary',
    auth: 'session',
    tags: ['documents'],
    summary: 'Счётчики навигатора: мои, на контроле, просроченные, черновики',
    handler: async (request) => DocumentService.summary(request.ctx),
  })

  route({
    route: 'GET /documents/office',
    auth: 'session',
    tags: ['documents'],
    summary: 'Дашборд «Канцелярия», если он заведён и виден пользователю',
    handler: async (request) => ({ dashboardId: await officeDashboardId(request.ctx) }),
  })

  // ─── Массовые действия в списке (ADR-0152) ─────────────────────────────────
  route({
    route: 'POST /documents/bulk',
    auth: 'session',
    tags: ['documents'],
    summary: 'Массовое действие над выбранными документами: подшить в дело, на ознакомление',
    description:
      'Права и состояние проверяются по каждому документу; отказ по одному не отменяет остальных.',
    handler: async (request) => DocumentBulk.run(request.ctx, request.body),
  })

  route({
    route: 'GET /documents/registry.xlsx',
    auth: 'session',
    tags: ['documents'],
    summary: 'Реестр выбранных документов в Excel',
    handler: async (request, reply) => {
      const content = await DocumentBulk.registry(request.ctx, request.query.ids)
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="kchs-documents.xlsx"')
      return reply.send(content)
    },
  })

  route({
    route: 'GET /documents/territory/:id',
    auth: { delegated: 'territoryDocuments → TerritoryService.get', objectType: 'territory' },
    tags: ['documents'],
    summary:
      'Документы территории для паспорта: по реквизиту «Территория», полю-территории карточки или связи «о территории», с вложенными единицами и правами на каждый документ (ADR-0158)',
    handler: async (request) =>
      territoryDocuments(request.ctx, request.params.id, request.query.limit),
  })

  route({
    route: 'POST /documents',
    auth: 'session',
    tags: ['documents'],
    summary: 'Создать черновик документа по типу',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentService.create(tx, request.ctx, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /documents/:id',
    auth: { delegated: 'DocumentService.get', objectType: 'document' },
    tags: ['documents'],
    summary: 'Карточка документа: реквизиты, регистрация, текущая версия, права',
    handler: async (request) => DocumentService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /documents/:id',
    auth: { delegated: 'DocumentService.update', objectType: 'document' },
    tags: ['documents'],
    summary: 'Изменить карточку: реквизиты, поля типа, участники, гриф',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /documents/:id/register',
    auth: { delegated: 'DocumentService.register', objectType: 'document' },
    tags: ['documents'],
    summary: 'Зарегистрировать документ: номер из журнала или резерва',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.register(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /documents/:id/number-preview',
    auth: { delegated: 'DocumentService.previewNumber', objectType: 'document' },
    tags: ['documents'],
    summary: 'Каким будет номер при регистрации: журнал и дело по номенклатуре, без выдачи',
    handler: async (request) =>
      DocumentService.previewNumber(request.ctx, request.params.id, request.query),
  })

  route({
    route: 'POST /documents/:id/cancel',
    auth: { delegated: 'DocumentService.cancel', objectType: 'document' },
    tags: ['documents'],
    summary: 'Аннулировать документ с обоснованием',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentService.cancel(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /documents/:id/versions',
    auth: { delegated: 'DocumentVersionService.list', objectType: 'document' },
    tags: ['documents'],
    summary: 'Версии документа: основной файл, приложения, PDF-представление',
    handler: async (request) => ({
      items: await DocumentVersionService.list(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /documents/:id/versions',
    auth: { delegated: 'DocumentVersionService.add', objectType: 'document' },
    tags: ['documents'],
    summary: 'Новая версия документа из прикреплённых файлов',
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
    route: 'POST /internal/documents/versions/:id/pdf',
    auth: { engineJob: { scope: (params) => `document-version:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок сообщает хэш версии и её PDF-представление',
    handler: async (request) => {
      const { stale } = await DocumentVersionService.applyPdfResult(request.params.id, request.body)
      return { ok: true, stale }
    },
  })

  // ─── Резолюции и исполнение (ADR-0084) ────────────────────────────────────
  route({
    route: 'GET /documents/:id/resolutions',
    auth: { delegated: 'ResolutionService.list', objectType: 'document' },
    tags: ['documents'],
    summary: 'Резолюции документа деревом, направления на резолюцию, права смотрящего',
    handler: async (request) => ResolutionService.list(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/resolutions',
    auth: { delegated: 'ResolutionService.create', objectType: 'document' },
    tags: ['documents'],
    summary: 'Наложить резолюцию: поручения ответственному и соисполнителям в той же транзакции',
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.create(tx, request.ctx, request.params.id, request.body),
      )
      return ResolutionService.list(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /documents/:id/resolution-requests',
    auth: { delegated: 'ResolutionService.request', objectType: 'document' },
    tags: ['documents'],
    summary: 'Направить документ на резолюцию (или переадресовать)',
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.request(tx, request.ctx, request.params.id, request.body),
      )
      return ResolutionService.list(request.ctx, request.params.id)
    },
  })

  route({
    route: 'DELETE /documents/:id/resolution-requests/:requestId',
    auth: { delegated: 'ResolutionService.cancelRequest', objectType: 'document' },
    tags: ['documents'],
    summary: 'Снять направление на резолюцию',
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
    route: 'POST /documents/:id/no-execution',
    auth: { delegated: 'ResolutionService.noExecution', objectType: 'document' },
    tags: ['documents'],
    summary: '«Не требует исполнения»: зарегистрированный документ исполнен без поручений',
    handler: async (request) => {
      await db().transaction((tx) =>
        ResolutionService.noExecution(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /documents/:id/acknowledgments',
    auth: { delegated: 'DocumentAcknowledgments.request', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отправить на ознакомление: сотрудники, подразделения, группы',
    handler: async (request) =>
      db().transaction((tx) =>
        DocumentAcknowledgments.request(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'GET /resolution-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Шаблоны резолюций: общие и личные',
    handler: async (request) => ({ items: await ResolutionTemplates.list(request.ctx) }),
  })

  route({
    route: 'POST /resolution-templates',
    auth: 'session',
    tags: ['documents'],
    summary: 'Новый шаблон резолюции (общий — канцелярия)',
    handler: async (request) => {
      await db().transaction((tx) => ResolutionTemplates.create(tx, request.ctx, request.body))
      return { items: await ResolutionTemplates.list(request.ctx) }
    },
  })

  route({
    route: 'PATCH /resolution-templates/:id',
    auth: { owned: 'ResolutionTemplates.editable — свои шаблоны резолюций' },
    tags: ['documents'],
    summary: 'Изменить шаблон резолюции',
    handler: async (request) =>
      db().transaction((tx) =>
        ResolutionTemplates.update(tx, request.ctx, request.params.id, request.body),
      ),
  })

  route({
    route: 'DELETE /resolution-templates/:id',
    auth: { owned: 'ResolutionTemplates.editable — свои шаблоны резолюций' },
    tags: ['documents'],
    summary: 'Удалить шаблон резолюции',
    handler: async (request) => {
      await db().transaction((tx) => ResolutionTemplates.remove(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })

  // ─── Переписка и дела (ADR-0086) ──────────────────────────────────────────
  route({
    route: 'POST /documents/:id/reply',
    auth: { delegated: 'Correspondence.reply', objectType: 'document' },
    tags: ['documents'],
    summary: 'Ответить на входящий: исходящий черновик со связью «в ответ на»',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        Correspondence.reply(tx, request.ctx, request.params.id, request.body),
      )
      return { id }
    },
  })

  route({
    route: 'GET /documents/:id/correspondence',
    auth: { delegated: 'Correspondence.chain', objectType: 'document' },
    tags: ['documents'],
    summary: 'Цепочка переписки по связям «в ответ на»',
    handler: async (request) => Correspondence.chain(request.ctx, request.params.id),
  })

  route({
    route: 'GET /documents/:id/dispatches',
    auth: { delegated: 'Correspondence.dispatches', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отметки об отправке исходящего',
    handler: async (request) => ({
      items: await Correspondence.dispatches(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /documents/:id/dispatches',
    auth: { delegated: 'Correspondence.dispatch', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отметить отправку исходящего; первая отправка исполняет документ',
    handler: async (request) => {
      await db().transaction((tx) =>
        Correspondence.dispatch(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /documents/mail-out/status',
    auth: 'session',
    tags: ['documents'],
    summary: 'Можно ли отправлять исходящие письмом и от чьего имени (ADR-0149)',
    handler: async () => DocumentMailOut.status(),
  })

  route({
    route: 'GET /documents/:id/emails',
    auth: { delegated: 'DocumentMailOut.list', objectType: 'document' },
    tags: ['documents'],
    summary: 'Письма исходящего: в очереди, отправленные, не ушедшие',
    handler: async (request) => ({
      items: await DocumentMailOut.list(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /documents/:id/emails',
    auth: { delegated: 'DocumentMailOut.queue', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отправить исходящий письмом из ящика канцелярии',
    description:
      'Письмо уходит заданием; отметка в реестре отправки появляется, когда почтовый сервер его принял.',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentMailOut.queue(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'POST /documents/:id/emails/:emailId/retry',
    auth: { delegated: 'DocumentMailOut.retry', objectType: 'document' },
    tags: ['documents'],
    summary: 'Повторить письмо, которое не ушло или вернулось',
    handler: async (request) => ({
      id: await db().transaction((tx) =>
        DocumentMailOut.retry(tx, request.ctx, request.params.id, request.params.emailId),
      ),
    }),
  })

  route({
    route: 'GET /documents/:id/cases',
    auth: { delegated: 'CaseService.suggest', objectType: 'document' },
    tags: ['documents'],
    summary:
      'Открытые дела для подшивки документа или номера при регистрации — подходящие по типу и подразделению',
    handler: async (request) =>
      CaseService.suggest(request.ctx, request.params.id, request.query.purpose),
  })

  route({
    route: 'POST /documents/:id/file',
    auth: { delegated: 'CaseService.fileDocument', objectType: 'document' },
    tags: ['documents'],
    summary: 'Подшить исполненный документ в дело',
    handler: async (request) => {
      await db().transaction((tx) =>
        CaseService.fileDocument(tx, request.ctx, request.params.id, request.body.caseId),
      )
      return DocumentService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /cases',
    auth: 'session',
    tags: ['documents'],
    summary: 'Номенклатура дел: дела по годам, состоянию, подразделению',
    handler: async (request) => ({ items: await CaseService.list(request.ctx, request.query) }),
  })

  route({
    route: 'GET /cases/import/template.xlsx',
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
    route: 'POST /cases/import',
    auth: 'session',
    tags: ['documents'],
    summary: 'Проверить или импортировать номенклатуру дел из загруженного файла Excel',
    handler: async (request) => CaseImport.run(request.ctx, request.body),
  })

  route({
    route: 'GET /cases/:id',
    auth: { delegated: 'CaseService.get', objectType: 'case' },
    tags: ['documents'],
    summary: 'Дело номенклатуры',
    handler: async (request) => CaseService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /cases',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Завести дело номенклатуры',
    handler: async (request) => {
      const id = await db().transaction((tx) => CaseService.create(tx, request.ctx, request.body))
      return CaseService.get(request.ctx, id)
    },
  })

  route({
    route: 'PATCH /cases/:id',
    auth: { delegated: 'CaseService.update', objectType: 'case' },
    tags: ['documents'],
    summary: 'Изменить дело номенклатуры',
    handler: async (request) => {
      await db().transaction((tx) =>
        CaseService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CaseService.get(request.ctx, request.params.id)
    },
  })

  for (const action of ['close', 'reopen', 'archive'] as const) {
    route({
      route: `POST /cases/:id/${action}` as const,
      auth: { delegated: 'CaseService.get', objectType: 'case' },
      tags: ['documents'],
      summary:
        action === 'close'
          ? 'Закрыть дело'
          : action === 'reopen'
            ? 'Вернуть закрытое дело в работу'
            : 'Передать закрытое дело в архив вместе с документами',
      handler: async (request) => {
        await db().transaction(async (tx) => {
          await CaseService[action](tx, request.ctx, request.params.id)
        })
        return CaseService.get(request.ctx, request.params.id)
      },
    })
  }

  route({
    route: 'POST /cases/close-year',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Закрыть открытые дела года',
    handler: async (request) => ({
      closed: await db().transaction((tx) =>
        CaseService.closeYear(tx, request.ctx, request.body.year),
      ),
    }),
  })

  route({
    route: 'GET /cases/destruction-acts',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Акты о выделении дел к уничтожению',
    handler: async (request) => ({ items: await CaseService.acts(request.ctx) }),
  })

  route({
    route: 'POST /cases/destruction-acts',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Акт о выделении к уничтожению: файлы дел удаляются, карточки остаются',
    handler: async (request) => {
      const id = await db().transaction((tx) => CaseService.destroy(tx, request.ctx, request.body))
      return { id }
    },
  })

  // ─── Типы документов ──────────────────────────────────────────────────────
  route({
    route: 'GET /document-types',
    auth: 'session',
    tags: ['documents'],
    summary: 'Типы документов',
    handler: async (request) => ({
      items: await DocumentTypeService.list(request.ctx, {
        includeInactive: request.query.includeInactive,
      }),
    }),
  })

  route({
    route: 'GET /document-types/:id',
    auth: { delegated: 'DocumentTypeService.get', objectType: 'document_type' },
    tags: ['documents'],
    summary: 'Тип документа',
    handler: async (request) => DocumentTypeService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /document-types',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать тип документа',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        DocumentTypeService.create(tx, request.ctx, request.body),
      )
      return DocumentTypeService.get(request.ctx, id)
    },
  })

  route({
    route: 'PATCH /document-types/:id',
    auth: { delegated: 'DocumentTypeService.update', objectType: 'document_type' },
    tags: ['documents'],
    summary: 'Изменить тип документа',
    handler: async (request) => {
      await db().transaction((tx) =>
        DocumentTypeService.update(tx, request.ctx, request.params.id, request.body),
      )
      return DocumentTypeService.get(request.ctx, request.params.id)
    },
  })

  // ─── Журналы ──────────────────────────────────────────────────────────────
  route({
    route: 'GET /journals',
    auth: 'session',
    tags: ['documents'],
    summary: 'Журналы регистрации, доступные пользователю',
    handler: async (request) => ({
      items: await JournalService.list(request.ctx, {
        includeInactive: request.query.includeInactive,
      }),
    }),
  })

  route({
    route: 'GET /journals/:id',
    auth: { delegated: 'JournalService.get', objectType: 'journal' },
    tags: ['documents'],
    summary: 'Журнал регистрации: счётчик, следующий номер, резервы',
    handler: async (request) => JournalService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /journals',
    auth: { capability: 'documents.journals.manage' },
    tags: ['documents'],
    summary: 'Создать журнал регистрации',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        JournalService.create(tx, request.ctx, request.body),
      )
      return JournalService.get(request.ctx, id)
    },
  })

  route({
    route: 'PATCH /journals/:id',
    auth: { delegated: 'JournalService.update', objectType: 'journal' },
    tags: ['documents'],
    summary: 'Изменить журнал регистрации',
    handler: async (request) => {
      await db().transaction((tx) =>
        JournalService.update(tx, request.ctx, request.params.id, request.body),
      )
      return JournalService.get(request.ctx, request.params.id)
    },
  })

  route({
    route: 'GET /journals/:id/reservations',
    auth: { delegated: 'JournalService.reservations', objectType: 'journal' },
    tags: ['documents'],
    summary: 'Зарезервированные номера журнала',
    handler: async (request) => ({
      items: await JournalService.reservations(request.ctx, request.params.id, request.query.state),
    }),
  })

  route({
    route: 'POST /journals/:id/reservations',
    auth: { delegated: 'JournalService.reserve', objectType: 'journal' },
    tags: ['documents'],
    summary: 'Зарезервировать номера для бумажных документов',
    handler: async (request) => ({
      items: await db().transaction((tx) =>
        JournalService.reserve(tx, request.ctx, request.params.id, request.body),
      ),
    }),
  })

  route({
    route: 'DELETE /journals/:id/reservations/:reservationId',
    auth: { delegated: 'JournalService.cancelReservation', objectType: 'journal' },
    tags: ['documents'],
    summary: 'Снять резерв номера',
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
    route: 'GET /correspondents',
    auth: 'session',
    tags: ['documents'],
    summary: 'Корреспонденты: поиск по названию и реквизитам',
    handler: async (request) => CorrespondentService.list(request.ctx, request.query),
  })

  route({
    route: 'GET /correspondents/:id',
    auth: { delegated: 'CorrespondentService.get', objectType: 'correspondent' },
    tags: ['documents'],
    summary: 'Корреспондент',
    handler: async (request) => CorrespondentService.get(request.ctx, request.params.id),
  })

  route({
    route: 'POST /correspondents',
    auth: { capability: 'documents.register' },
    tags: ['documents'],
    summary: 'Создать корреспондента',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        CorrespondentService.create(tx, request.ctx, request.body),
      )
      return CorrespondentService.get(request.ctx, id)
    },
  })

  route({
    route: 'PATCH /correspondents/:id',
    auth: { delegated: 'CorrespondentService.update', objectType: 'correspondent' },
    tags: ['documents'],
    summary: 'Изменить корреспондента',
    handler: async (request) => {
      await db().transaction((tx) =>
        CorrespondentService.update(tx, request.ctx, request.params.id, request.body),
      )
      return CorrespondentService.get(request.ctx, request.params.id)
    },
  })
}
