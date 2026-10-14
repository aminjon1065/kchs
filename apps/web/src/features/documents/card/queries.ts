import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const documentsCardApi = {
  postObjectsAcknowledgmentsAcknowledge: (
    id: string,
    body: ApiBody<'POST /objects/:id/acknowledgments/acknowledge'>,
  ) => http.post('/objects/:id/acknowledgments/acknowledge', { params: { id }, body }),
  postObjectsAcknowledgmentsRemind: (id: string) =>
    http.post('/objects/:id/acknowledgments/remind', { params: { id }, body: {} }),
  postAcknowledgments: (id: string, body: ApiBody<'POST /documents/:id/acknowledgments'>) =>
    http.post('/documents/:id/acknowledgments', { params: { id }, body }),
  patch: (id: string, body: ApiBody<'PATCH /documents/:id'>) =>
    http.patch('/documents/:id', { params: { id }, body }),
  postRegister: (id: string, body: ApiBody<'POST /documents/:id/register'>) =>
    http.post('/documents/:id/register', { params: { id }, body }),
  postCancel: (id: string, body: ApiBody<'POST /documents/:id/cancel'>) =>
    http.post('/documents/:id/cancel', { params: { id }, body }),
  postVersions: (id: string, body: ApiBody<'POST /documents/:id/versions'>) =>
    http.post('/documents/:id/versions', { params: { id }, body }),
  removeObjectsLinks: (id: string, targetId: string, kind: string) =>
    http.delete('/objects/:id/links/:targetId/:kind', { params: { id, targetId, kind } }),
  postReply: (id: string) => http.post('/documents/:id/reply', { params: { id }, body: {} }),
  postObjectsLinks: (id: string, body: ApiBody<'POST /objects/:id/links'>) =>
    http.post('/objects/:id/links', { params: { id }, body }),
  postEmails: (id: string, body: ApiBody<'POST /documents/:id/emails'>) =>
    http.post('/documents/:id/emails', { params: { id }, body }),
  postDispatches: (id: string, body: ApiBody<'POST /documents/:id/dispatches'>) =>
    http.post('/documents/:id/dispatches', { params: { id }, body }),
  postFile: (id: string, body: ApiBody<'POST /documents/:id/file'>) =>
    http.post('/documents/:id/file', { params: { id }, body }),
  postEmailsRetry: (id: string, emailId: string) =>
    http.post('/documents/:id/emails/:emailId/retry', { params: { id, emailId } }),
  postResolutions: (id: string, body: ApiBody<'POST /documents/:id/resolutions'>) =>
    http.post('/documents/:id/resolutions', { params: { id }, body }),
  postResolutionRequests: (id: string, body: ApiBody<'POST /documents/:id/resolution-requests'>) =>
    http.post('/documents/:id/resolution-requests', { params: { id }, body }),
  postNoExecution: (id: string, body: ApiBody<'POST /documents/:id/no-execution'>) =>
    http.post('/documents/:id/no-execution', { params: { id }, body }),
  removeResolutionRequests: (id: string, requestId: string) =>
    http.delete('/documents/:id/resolution-requests/:requestId', { params: { id, requestId } }),
  postRoutesPreview: (id: string, body: ApiBody<'POST /documents/:id/routes/preview'>) =>
    http.post('/documents/:id/routes/preview', { params: { id }, body }),
  postRoutes: (id: string, body: ApiBody<'POST /documents/:id/routes'>) =>
    http.post('/documents/:id/routes', { params: { id }, body }),
}
