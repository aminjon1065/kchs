import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const documentsDirectoriesApi = {
  /** Закрыть, открыть снова или передать в архив дело номенклатуры. */
  postCasesAction: (id: string, action: 'close' | 'reopen' | 'archive') =>
    http.post(`/cases/:id/${action}` as const, { params: { id } }),
  postCasesImport: (body: ApiBody<'POST /cases/import'>) => http.post('/cases/import', { body }),
  postCasesCloseYear: (body: ApiBody<'POST /cases/close-year'>) =>
    http.post('/cases/close-year', { body }),
  patchCases: (id: string, body: ApiBody<'PATCH /cases/:id'>) =>
    http.patch('/cases/:id', { params: { id }, body }),
  postCases: (body: ApiBody<'POST /cases'>) => http.post('/cases', { body }),
  postCasesDestructionActs: (body: ApiBody<'POST /cases/destruction-acts'>) =>
    http.post('/cases/destruction-acts', { body }),
  patchCorrespondents: (id: string, body: ApiBody<'PATCH /correspondents/:id'>) =>
    http.patch('/correspondents/:id', { params: { id }, body }),
  postCorrespondents: (body: ApiBody<'POST /correspondents'>) =>
    http.post('/correspondents', { body }),
  patchJournals: (id: string, body: ApiBody<'PATCH /journals/:id'>) =>
    http.patch('/journals/:id', { params: { id }, body }),
  postJournalsReservations: (id: string, body: ApiBody<'POST /journals/:id/reservations'>) =>
    http.post('/journals/:id/reservations', { params: { id }, body }),
  removeJournalsReservations: (id: string, reservationId: string) =>
    http.delete('/journals/:id/reservations/:reservationId', { params: { id, reservationId } }),
  postJournals: (body: ApiBody<'POST /journals'>) => http.post('/journals', { body }),
  patchDocumentTemplates: (id: string, body: ApiBody<'PATCH /document-templates/:id'>) =>
    http.patch('/document-templates/:id', { params: { id }, body }),
  postDocumentTemplatesFile: (id: string, body: ApiBody<'POST /document-templates/:id/file'>) =>
    http.post('/document-templates/:id/file', { params: { id }, body }),
  postDocumentTemplates: (body: ApiBody<'POST /document-templates'>) =>
    http.post('/document-templates', { body }),
  patchDocumentTypes: (id: string, body: ApiBody<'PATCH /document-types/:id'>) =>
    http.patch('/document-types/:id', { params: { id }, body }),
}
