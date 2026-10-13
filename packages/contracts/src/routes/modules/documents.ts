import { z } from 'zod'
import {
  DocumentAssistStatus,
  DocumentClassification,
  DocumentExtraction,
  DocumentReplyDraft,
  DocumentReplyDraftInput,
  DocumentSummaryDraft,
} from '../../documents/assist.js'
import {
  DocumentBulkInput,
  DocumentBulkResult,
  DocumentRegistryQuery,
} from '../../documents/bulk.js'
import {
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
  DestructionActInput,
  DestructionActList,
  DocumentFileInput,
} from '../../documents/case.js'
import { VersionCompareQuery, VersionCompareResult } from '../../documents/compare.js'
import {
  CorrespondenceChain,
  DocumentDispatchInput,
  DocumentDispatchList,
  DocumentEmailInput,
  DocumentEmailList,
  DocumentMailStatus,
  DocumentReplyInput,
} from '../../documents/correspondence.js'
import {
  CorrespondentInput,
  CorrespondentList,
  CorrespondentListQuery,
  CorrespondentRecord,
  CorrespondentUpdateInput,
} from '../../documents/correspondent.js'
import {
  DocumentCancelInput,
  DocumentCreateInput,
  DocumentIntakeResult,
  DocumentNumberPreview,
  DocumentNumberPreviewQuery,
  DocumentPhoto,
  DocumentPhotoUploadInput,
  DocumentRecord,
  DocumentRegisterInput,
  DocumentSummary,
  DocumentTerritoryList,
  DocumentTerritoryQuery,
  DocumentUpdateInput,
  DocumentVersionInput,
  DocumentVersionList,
  DocumentVersionRecord,
} from '../../documents/document.js'
import {
  DocumentTypeCreateInput,
  DocumentTypeRecord,
  DocumentTypeUpdateInput,
} from '../../documents/document-type.js'
import {
  JournalCreateInput,
  JournalRecord,
  JournalReservation,
  JournalReservationList,
  JournalReservationState,
  JournalReserveInput,
  JournalUpdateInput,
} from '../../documents/journal.js'
import {
  MailMessageList,
  MailMessageListQuery,
  MailMessageRecord,
  MailPollReport,
  MailRejectInput,
} from '../../documents/mail.js'
import {
  DocumentRenderDownload,
  DocumentRenderList,
  DocumentRenderRecord,
  PrintFormList,
  PrintRequestInput,
  WatermarkRequestInput,
} from '../../documents/print.js'
import {
  QesCertificateInput,
  QesPageState,
  QesResultInput,
  QesSessionRecord,
  QesSessionStartInput,
  QesTicketQuery,
  QesVerifyQueued,
} from '../../documents/qualified.js'
import {
  DocumentResolutions,
  NoExecutionInput,
  ResolutionInput,
  ResolutionRequestInput,
  ResolutionTemplate,
  ResolutionTemplateInput,
  ResolutionTemplateUpdateInput,
} from '../../documents/resolution.js'
import { DocumentSignature, SignaturePlacementInput } from '../../documents/route.js'
import {
  DocumentFillInput,
  DocumentFromTemplateInput,
  DocumentFromTemplateResult,
  DocumentTemplateCreateInput,
  DocumentTemplateFileInput,
  DocumentTemplateList,
  DocumentTemplateListQuery,
  DocumentTemplateRecord,
  DocumentTemplateUpdateInput,
} from '../../documents/template.js'
import { ENGINE_CALLBACKS } from '../../engine/callbacks.js'
import { defineRoutes } from '../../http/route-contract.js'
import {
  AcknowledgmentRequestInput,
  AcknowledgmentRequestResult,
} from '../../objects/acknowledgment.js'
import { IdParam, Ok } from '../params.js'

const SubjectQuery = z.object({ subjectId: z.uuid() })

/**
 * Маршруты модуля «documents» (ADR-0188). Регистрация —
 * `apps/api/src/modules/documents/http/`: assist-routes.ts, mail-routes.ts, render-routes.ts,
 * routes.ts, template-routes.ts.
 */
export const documentsRoutes = defineRoutes({
  'GET /documents/:id/assist': { params: IdParam, response: { 200: DocumentAssistStatus } },
  'POST /documents/:id/assist/extract': { params: IdParam, response: { 200: DocumentExtraction } },
  'POST /documents/:id/assist/classify': {
    params: IdParam,
    response: { 200: DocumentClassification },
  },
  'POST /documents/:id/assist/summary': {
    params: IdParam,
    response: { 200: DocumentSummaryDraft },
  },
  'POST /documents/:id/assist/reply': {
    params: IdParam,
    body: DocumentReplyDraftInput,
    response: { 200: DocumentReplyDraft },
  },
  'GET /documents/mail': { query: MailMessageListQuery, response: { 200: MailMessageList } },
  'GET /documents/mail/:id': { params: IdParam, response: { 200: MailMessageRecord } },
  'POST /documents/mail/:id/reject': {
    params: IdParam,
    body: MailRejectInput,
    response: { 200: MailMessageRecord },
  },
  'POST /documents/mail/poll': {
    query: z.object({ integrationId: z.uuid().optional() }),
    response: { 200: MailPollReport },
  },
  'GET /documents/print-forms': { query: SubjectQuery, response: { 200: PrintFormList } },
  'POST /documents/prints': { body: PrintRequestInput, response: { 200: DocumentRenderRecord } },
  'POST /documents/watermarked': {
    body: WatermarkRequestInput,
    response: { 200: DocumentRenderRecord },
  },
  'GET /documents/renders': { query: SubjectQuery, response: { 200: DocumentRenderList } },
  'GET /documents/renders/:id': { params: IdParam, response: { 200: DocumentRenderRecord } },
  'GET /documents/renders/:id/download': {
    params: IdParam,
    response: { 200: DocumentRenderDownload },
  },
  'GET /documents/:id/versions/compare': {
    params: IdParam,
    query: VersionCompareQuery,
    response: { 200: VersionCompareResult },
  },
  // Место факсимиле на подписанном экземпляре (ADR-0198): экземпляр строится заново
  'PUT /documents/:id/signatures/:signatureId/placement': {
    params: z.object({ id: z.uuid(), signatureId: z.uuid() }),
    body: SignaturePlacementInput,
    response: { 200: DocumentSignature },
  },
  // Страница проверки подписи по QR (ADR-0198): HTML без входа, открыта и через
  // шлюз DMZ (ADR-0200) — QR на бумаге читают вне Комитета
  'GET /verify/:id': { params: IdParam, exposure: 'public' },
  // Квалифицированная подпись (ADR-0205): сеанс из карточки, повторная проверка
  'POST /documents/:id/qes-sessions': {
    params: IdParam,
    body: QesSessionStartInput,
    response: { 200: QesSessionRecord },
  },
  'GET /documents/:id/qes-sessions/:sessionId': {
    params: z.object({ id: z.uuid(), sessionId: z.uuid() }),
    response: { 200: QesSessionRecord },
  },
  'POST /documents/:id/signatures/:signatureId/verify': {
    params: z.object({ id: z.uuid(), signatureId: z.uuid() }),
    response: { 200: QesVerifyQueued },
  },
  // Страница подписания (HTML со своей CSP) и её маршруты по билету — только внутри
  // сети: агент УЦ на рабочем месте сотрудника, через шлюз DMZ страница не открыта
  'GET /qes/sessions/:id/page': { params: IdParam, query: QesTicketQuery },
  'GET /qes/sessions/:id/state': {
    params: IdParam,
    query: QesTicketQuery,
    response: { 200: QesPageState },
  },
  'POST /qes/sessions/:id/certificate': {
    params: IdParam,
    query: QesTicketQuery,
    body: QesCertificateInput,
    response: { 200: QesPageState },
  },
  'POST /qes/sessions/:id/result': {
    params: IdParam,
    query: QesTicketQuery,
    body: QesResultInput,
    response: { 200: QesPageState },
  },
  'POST /internal/documents/signature-sessions/:id/start': {
    params: IdParam,
    body: ENGINE_CALLBACKS.documentSignatureStart.body,
    response: { 200: ENGINE_CALLBACKS.documentSignatureStart.reply },
  },
  'POST /internal/documents/signature-sessions/:id/done': {
    params: IdParam,
    body: ENGINE_CALLBACKS.documentSignatureDone.body,
    response: { 200: ENGINE_CALLBACKS.documentSignatureDone.reply },
  },
  'POST /internal/documents/renders/:id/start': {
    params: IdParam,
    response: { 200: ENGINE_CALLBACKS.documentRenderStart.reply },
  },
  'POST /internal/documents/renders/:id/done': {
    params: IdParam,
    body: ENGINE_CALLBACKS.documentRenderDone.body,
    response: { 200: ENGINE_CALLBACKS.documentRenderDone.reply },
  },
  'GET /documents/summary': { response: { 200: DocumentSummary } },
  'GET /documents/office': { response: { 200: z.object({ dashboardId: z.uuid().nullable() }) } },
  'POST /documents/bulk': { body: DocumentBulkInput, response: { 200: DocumentBulkResult } },
  'GET /documents/registry.xlsx': { query: DocumentRegistryQuery },
  'GET /documents/territory/:id': {
    params: IdParam,
    query: DocumentTerritoryQuery,
    response: { 200: DocumentTerritoryList },
  },
  'POST /documents': { body: DocumentCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'POST /documents/:id/photos': {
    params: IdParam,
    body: DocumentPhotoUploadInput,
    response: { 200: DocumentPhoto },
  },
  'POST /documents/:id/intake': { params: IdParam, response: { 200: DocumentIntakeResult } },
  'GET /documents/:id': { params: IdParam, response: { 200: DocumentRecord } },
  'PATCH /documents/:id': {
    params: IdParam,
    body: DocumentUpdateInput,
    response: { 200: DocumentRecord },
  },
  'POST /documents/:id/register': {
    params: IdParam,
    body: DocumentRegisterInput,
    response: { 200: DocumentRecord },
  },
  'GET /documents/:id/number-preview': {
    params: IdParam,
    query: DocumentNumberPreviewQuery,
    response: { 200: DocumentNumberPreview },
  },
  'POST /documents/:id/cancel': {
    params: IdParam,
    body: DocumentCancelInput,
    response: { 200: DocumentRecord },
  },
  'GET /documents/:id/versions': { params: IdParam, response: { 200: DocumentVersionList } },
  'POST /documents/:id/versions': {
    params: IdParam,
    body: DocumentVersionInput,
    response: { 200: DocumentVersionRecord },
  },
  'POST /internal/documents/versions/:id/pdf': {
    params: IdParam,
    body: ENGINE_CALLBACKS.documentPdf.body,
    response: { 200: ENGINE_CALLBACKS.documentPdf.reply },
  },
  'GET /documents/:id/resolutions': { params: IdParam, response: { 200: DocumentResolutions } },
  'POST /documents/:id/resolutions': {
    params: IdParam,
    body: ResolutionInput,
    response: { 200: DocumentResolutions },
  },
  'POST /documents/:id/resolution-requests': {
    params: IdParam,
    body: ResolutionRequestInput,
    response: { 200: DocumentResolutions },
  },
  'DELETE /documents/:id/resolution-requests/:requestId': {
    params: z.object({ id: z.uuid(), requestId: z.uuid() }),
    response: { 200: DocumentResolutions },
  },
  'POST /documents/:id/no-execution': {
    params: IdParam,
    body: NoExecutionInput,
    response: { 200: DocumentRecord },
  },
  'POST /documents/:id/acknowledgments': {
    params: IdParam,
    body: AcknowledgmentRequestInput,
    response: { 200: AcknowledgmentRequestResult },
  },
  'GET /resolution-templates': {
    response: { 200: z.object({ items: z.array(ResolutionTemplate) }) },
  },
  'POST /resolution-templates': {
    body: ResolutionTemplateInput,
    response: { 200: z.object({ items: z.array(ResolutionTemplate) }) },
  },
  'PATCH /resolution-templates/:id': {
    params: IdParam,
    body: ResolutionTemplateUpdateInput,
    response: { 200: ResolutionTemplate },
  },
  'DELETE /resolution-templates/:id': { params: IdParam, response: { 200: Ok } },
  'POST /documents/:id/reply': {
    params: IdParam,
    body: DocumentReplyInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /documents/:id/correspondence': { params: IdParam, response: { 200: CorrespondenceChain } },
  'GET /documents/:id/dispatches': { params: IdParam, response: { 200: DocumentDispatchList } },
  'POST /documents/:id/dispatches': {
    params: IdParam,
    body: DocumentDispatchInput,
    response: { 200: DocumentRecord },
  },
  'GET /documents/mail-out/status': { response: { 200: DocumentMailStatus } },
  'GET /documents/:id/emails': { params: IdParam, response: { 200: DocumentEmailList } },
  'POST /documents/:id/emails': {
    params: IdParam,
    body: DocumentEmailInput,
    response: { 200: DocumentRecord },
  },
  'POST /documents/:id/emails/:emailId/retry': {
    params: z.object({ id: z.uuid(), emailId: z.uuid() }),
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /documents/:id/cases': {
    params: IdParam,
    query: CaseSuggestionsQuery,
    response: { 200: CaseSuggestions },
  },
  'POST /documents/:id/file': {
    params: IdParam,
    body: DocumentFileInput,
    response: { 200: DocumentRecord },
  },
  'GET /cases': { query: CaseListQuery, response: { 200: CaseList } },
  'GET /cases/import/template.xlsx': {},
  'POST /cases/import': { body: CaseImportInput, response: { 200: CaseImportReport } },
  'GET /cases/:id': { params: IdParam, response: { 200: CaseRecord } },
  'POST /cases': { body: CaseCreateInput, response: { 200: CaseRecord } },
  'PATCH /cases/:id': { params: IdParam, body: CaseUpdateInput, response: { 200: CaseRecord } },
  'POST /cases/:id/close': { params: IdParam, response: { 200: CaseRecord } },
  'POST /cases/:id/reopen': { params: IdParam, response: { 200: CaseRecord } },
  'POST /cases/:id/archive': { params: IdParam, response: { 200: CaseRecord } },
  'POST /cases/close-year': {
    body: CaseCloseYearInput,
    response: { 200: z.object({ closed: z.number() }) },
  },
  'GET /cases/destruction-acts': { response: { 200: DestructionActList } },
  'POST /cases/destruction-acts': {
    body: DestructionActInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'GET /document-types': {
    query: z.object({ includeInactive: z.coerce.boolean().default(false) }),
    response: { 200: z.object({ items: z.array(DocumentTypeRecord) }) },
  },
  'GET /document-types/:id': { params: IdParam, response: { 200: DocumentTypeRecord } },
  'POST /document-types': { body: DocumentTypeCreateInput, response: { 200: DocumentTypeRecord } },
  'PATCH /document-types/:id': {
    params: IdParam,
    body: DocumentTypeUpdateInput,
    response: { 200: DocumentTypeRecord },
  },
  'GET /journals': {
    query: z.object({ includeInactive: z.coerce.boolean().default(false) }),
    response: { 200: z.object({ items: z.array(JournalRecord) }) },
  },
  'GET /journals/:id': { params: IdParam, response: { 200: JournalRecord } },
  'POST /journals': { body: JournalCreateInput, response: { 200: JournalRecord } },
  'PATCH /journals/:id': {
    params: IdParam,
    body: JournalUpdateInput,
    response: { 200: JournalRecord },
  },
  'GET /journals/:id/reservations': {
    params: IdParam,
    query: z.object({ state: JournalReservationState.optional() }),
    response: { 200: JournalReservationList },
  },
  'POST /journals/:id/reservations': {
    params: IdParam,
    body: JournalReserveInput,
    response: { 200: z.object({ items: z.array(JournalReservation) }) },
  },
  'DELETE /journals/:id/reservations/:reservationId': {
    params: z.object({ id: z.uuid(), reservationId: z.uuid() }),
    response: { 200: Ok },
  },
  'GET /correspondents': { query: CorrespondentListQuery, response: { 200: CorrespondentList } },
  'GET /correspondents/:id': { params: IdParam, response: { 200: CorrespondentRecord } },
  'POST /correspondents': { body: CorrespondentInput, response: { 200: CorrespondentRecord } },
  'PATCH /correspondents/:id': {
    params: IdParam,
    body: CorrespondentUpdateInput,
    response: { 200: CorrespondentRecord },
  },
  'GET /document-templates': {
    query: DocumentTemplateListQuery,
    response: { 200: DocumentTemplateList },
  },
  'GET /document-templates/:id': { params: IdParam, response: { 200: DocumentTemplateRecord } },
  'POST /document-templates': {
    body: DocumentTemplateCreateInput,
    response: { 200: DocumentTemplateRecord },
  },
  'PATCH /document-templates/:id': {
    params: IdParam,
    body: DocumentTemplateUpdateInput,
    response: { 200: DocumentTemplateRecord },
  },
  'POST /document-templates/:id/file': {
    params: IdParam,
    body: DocumentTemplateFileInput,
    response: { 200: DocumentTemplateRecord },
  },
  'POST /documents/from-template': {
    body: DocumentFromTemplateInput,
    response: { 200: DocumentFromTemplateResult },
  },
  'POST /documents/:id/fill': {
    params: IdParam,
    body: DocumentFillInput,
    response: { 200: DocumentRenderRecord },
  },
})
