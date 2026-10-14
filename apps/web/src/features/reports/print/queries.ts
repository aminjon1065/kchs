import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

export const reportsPrintApi = {
  getMe: () => http.get('/me', { anonymous: true }),
  postDashboardsData: (id: string, body: ApiBody<'POST /dashboards/:id/data'>) =>
    http.post('/dashboards/:id/data', { params: { id }, body, anonymous: true }),
  postQueriesRun: (body: ApiBody<'POST /queries/run'>) => http.post('/queries/run', { body }),
  postSqlRun: (body: ApiBody<'POST /sql/run'>) => http.post('/sql/run', { body }),
  postChartsData: (id: string) => http.post('/charts/:id/data', { params: { id }, body: {} }),
  postMetricsValue: (id: string, body: ApiBody<'POST /metrics/:id/value'>) =>
    http.post('/metrics/:id/value', { params: { id }, body }),
  getImages: (id: string, fileId: string) =>
    http.get('/reports/:id/images/:fileId', { params: { id, fileId } }),
  getFiles: (id: string, query: ApiQuery<'GET /reports/:id/files'>) =>
    http.get('/reports/:id/files', { params: { id }, query }),
  getDashboards: (id: string) => http.get('/dashboards/:id', { params: { id } }),
  postData: (id: string) =>
    http.post('/dashboards/:id/data', { params: { id }, body: { filters: {} } }),
  getPrintReportRuns: (runId: string) =>
    http.get('/print/report-runs/:runId', { params: { runId }, anonymous: true }),
  getPrintReports: (id: string) =>
    http.get('/print/reports/:id', { params: { id }, anonymous: true }),
}

export const dashboardsQuery = (id: string) =>
  queryOptions({
    queryKey: ['print', 'dashboard', id],
    queryFn: () => http.get('/dashboards/:id', { params: { id }, anonymous: true }),
  })
