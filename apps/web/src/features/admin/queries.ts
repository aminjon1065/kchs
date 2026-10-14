import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const adminApi = {
  removeMeAdminMode: () => http.delete('/me/admin-mode'),
  postMeAdminMode: (body: ApiBody<'POST /me/admin-mode'>) => http.post('/me/admin-mode', { body }),
  postAnnouncementsWithdraw: (id: string) =>
    http.post('/admin/announcements/:id/withdraw', { params: { id } }),
  postAnnouncements: (body: ApiBody<'POST /admin/announcements'>) =>
    http.post('/admin/announcements', { body }),
  removeApiTokens: (id: string) => http.delete('/admin/api-tokens/:id', { params: { id } }),
  getBackups: () => http.get('/admin/backups'),
  postBackups: () => http.post('/admin/backups'),
  postBackupsVerified: (id: string) =>
    http.post('/admin/backups/:id/verified', { params: { id }, body: { note: '' } }),
  getBackupsRestoreChecks: () => http.get('/admin/backups/restore-checks'),
  postMaintenanceReindex: () => http.post('/admin/maintenance/reindex'),
  putGisRenderSettings: (body: ApiBody<'PUT /admin/gis/render-settings'>) =>
    http.put('/admin/gis/render-settings', { body }),
  postGisBasemapsDefault: (id: string) =>
    http.post('/gis/basemaps/:id/default', { params: { id } }),
  removeGisBasemaps: (id: string) => http.delete('/gis/basemaps/:id', { params: { id } }),
  postGisBasemaps: (body: ApiBody<'POST /gis/basemaps'>) => http.post('/gis/basemaps', { body }),
  patchGisBasemaps: (id: string, body: ApiBody<'PATCH /gis/basemaps/:id'>) =>
    http.patch('/gis/basemaps/:id', { params: { id }, body }),
  patchBranding: (body: ApiBody<'PATCH /admin/branding'>) =>
    http.patch('/admin/branding', { body }),
  removeBusinessCalendar: (day: string) =>
    http.delete('/admin/business-calendar/:day', { params: { day } }),
  putBusinessCalendar: (day: string, body: ApiBody<'PUT /admin/business-calendar/:day'>) =>
    http.put('/admin/business-calendar/:day', { params: { day }, body }),
  getDataColumnar: () => http.get('/admin/data/columnar'),
  putDataColumnarSettings: (body: ApiBody<'PUT /admin/data/columnar/settings'>) =>
    http.put('/admin/data/columnar/settings', { body }),
  postDatasetsColumnarBuild: (id: string) =>
    http.post('/datasets/:id/columnar/build', { params: { id } }),
  postConfigExport: (body: ApiBody<'POST /config/export'>) => http.post('/config/export', { body }),
  postConfigImportPreview: (body: ApiBody<'POST /config/import/preview'>) =>
    http.post('/config/import/preview', { body }),
  postConfigImport: (body: ApiBody<'POST /config/import'>) => http.post('/config/import', { body }),
  putDirectory: (body: ApiBody<'PUT /admin/directory'>) => http.put('/admin/directory', { body }),
  postDirectoryTest: () => http.post('/admin/directory/test'),
  postDirectoryPreview: () => http.post('/admin/directory/preview'),
  postDirectorySync: () => http.post('/admin/directory/sync'),
  getEventsDlq: (query: ApiQuery<'GET /admin/events/dlq'>) =>
    http.get('/admin/events/dlq', { query }),
  postEventsDlqRetry: (id: string) => http.post('/admin/events/dlq/:id/retry', { params: { id } }),
  postEventsDlqRetryAll: () => http.post('/admin/events/dlq/retry-all'),
  getFeatures: () => http.get('/admin/features'),
  patchFeatures: (key: string, body: ApiBody<'PATCH /admin/features/:key'>) =>
    http.patch('/admin/features/:key', { params: { key }, body }),
  getGroups: () => http.get('/groups'),
  getGroupsMembers: (id: string) => http.get('/groups/:id/members', { params: { id } }),
  postGroups: (body: ApiBody<'POST /groups'>) => http.post('/groups', { body }),
  patchGroups: (id: string, body: ApiBody<'PATCH /groups/:id'>) =>
    http.patch('/groups/:id', { params: { id }, body }),
  putGroupsMembers: (id: string, body: ApiBody<'PUT /groups/:id/members'>) =>
    http.put('/groups/:id/members', { params: { id }, body }),
  getKnowledgeHelpPages: () => http.get('/knowledge/help/pages'),
  putKnowledgeHelpPages: (body: ApiBody<'PUT /knowledge/help/pages'>) =>
    http.put('/knowledge/help/pages', { body }),
  postIntegrationsBuiltinCheck: (key: string) =>
    http.post('/integrations/builtin/:key/check', { params: { key } }),
  postIntegrationsCheck: (id: string) => http.post('/integrations/:id/check', { params: { id } }),
  postIntegrationsInboundSecret: (id: string) =>
    http.post('/integrations/:id/inbound-secret', { params: { id } }),
  postIntegrations: (body: ApiBody<'POST /integrations'>) => http.post('/integrations', { body }),
  getIntegrationsSyncs: (id: string) =>
    http.get('/integrations/:id/syncs', { params: { id }, query: { limit: 10 } }),
  patchIntegrations: (id: string, body: ApiBody<'PATCH /integrations/:id'>) =>
    http.patch('/integrations/:id', { params: { id }, body }),
  patchWebhooks: (id: string, body: ApiBody<'PATCH /webhooks/:id'>) =>
    http.patch('/webhooks/:id', { params: { id }, body }),
  removeWebhooks: (id: string) => http.delete('/webhooks/:id', { params: { id } }),
  postWebhooks: (body: ApiBody<'POST /webhooks'>) => http.post('/webhooks', { body }),
  postWebhooksDeliveriesRetry: (id: string, deliveryId: string) =>
    http.post('/webhooks/:id/deliveries/:deliveryId/retry', { params: { id, deliveryId } }),
  getMeetingsSettings: () => http.get('/admin/meetings/settings'),
  putMeetingsSettings: (body: ApiBody<'PUT /admin/meetings/settings'>) =>
    http.put('/admin/meetings/settings', { body }),
  postOrgUnits: (body: ApiBody<'POST /org/units'>) => http.post('/org/units', { body }),
  patchOrgUnits: (id: string, body: ApiBody<'PATCH /org/units/:id'>) =>
    http.patch('/org/units/:id', { params: { id }, body }),
  getOrgPositions: () => http.get('/org/positions'),
  removeOrgPositions: (id: string) => http.delete('/org/positions/:id', { params: { id } }),
  patchOrgPositions: (id: string, body: ApiBody<'PATCH /org/positions/:id'>) =>
    http.patch('/org/positions/:id', { params: { id }, body }),
  postOrgPositions: (body: ApiBody<'POST /org/positions'>) => http.post('/org/positions', { body }),
  patchRoles: (id: string, body: ApiBody<'PATCH /roles/:id'>) =>
    http.patch('/roles/:id', { params: { id }, body }),
  postRoles: (body: ApiBody<'POST /roles'>) => http.post('/roles', { body }),
  removeRoles: (id: string) => http.delete('/roles/:id', { params: { id } }),
  patchSecurityPolicy: (body: ApiBody<'PATCH /admin/security-policy'>) =>
    http.patch('/admin/security-policy', { body }),
  getServiceAccounts: (id: string) => http.get('/service-accounts/:id', { params: { id } }),
  patchServiceAccounts: (id: string, body: ApiBody<'PATCH /service-accounts/:id'>) =>
    http.patch('/service-accounts/:id', { params: { id }, body }),
  postServiceAccounts: (body: ApiBody<'POST /service-accounts'>) =>
    http.post('/service-accounts', { body }),
  postSpacesAdmins: (id: string, body: ApiBody<'POST /admin/spaces/:id/admins'>) =>
    http.post('/admin/spaces/:id/admins', { params: { id }, body }),
  putSso: (body: ApiBody<'PUT /admin/sso'>) => http.put('/admin/sso', { body }),
  postSsoTest: () => http.post('/admin/sso/test'),
  putTasksSettings: (body: ApiBody<'PUT /admin/tasks/settings'>) =>
    http.put('/admin/tasks/settings', { body }),
  postTasksMetrics: (body: ApiBody<'POST /admin/tasks/metrics'>) =>
    http.post('/admin/tasks/metrics', { body }),
  postUsers: (body: ApiBody<'POST /users'>) => http.post('/users', { body }),
  patchUsers: (id: string, body: ApiBody<'PATCH /users/:id'>) =>
    http.patch('/users/:id', { params: { id }, body }),
  postUsersResetPassword: (id: string) =>
    http.post('/users/:id/reset-password', { params: { id } }),
  postUsersResetMfa: (id: string) => http.post('/users/:id/reset-mfa', { params: { id } }),
  putUsersClearance: (id: string, body: ApiBody<'PUT /users/:id/clearance'>) =>
    http.put('/users/:id/clearance', { params: { id }, body }),
  getUsersPasskeys: (id: string) => http.get('/users/:id/passkeys', { params: { id } }),
  removeUsersPasskeys: (id: string) => http.delete('/users/:id/passkeys', { params: { id } }),
  postUsersImport: (body: ApiBody<'POST /admin/users/import'>) =>
    http.post('/admin/users/import', { body }),
}

export const configSectionsQuery = () =>
  queryOptions({
    queryKey: ['config', 'sections'],
    queryFn: () => http.get('/config/sections'),
  })
