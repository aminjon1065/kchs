import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

export const notebooksApi = {
  create: (body: ApiBody<'POST /notebooks'>) => http.post('/notebooks', { body }),
  updateObject: (id: string, body: ApiBody<'PATCH /objects/:id'>) =>
    http.patch('/objects/:id', { params: { id }, body }),
  removeObject: (id: string) => http.delete('/objects/:id', { params: { id } }),
  restoreObject: (id: string) => http.post('/objects/:id/restore', { params: { id } }),
  postReportsFromNotebook: (body: ApiBody<'POST /reports/from-notebook'>) =>
    http.post('/reports/from-notebook', { body }),
  postQueriesRun: (body: ApiBody<'POST /queries/run'>) => http.post('/queries/run', { body }),
  postSqlRun: (body: ApiBody<'POST /sql/run'>) => http.post('/sql/run', { body }),
  postDatasetsAsk: (id: string, body: ApiBody<'POST /datasets/:id/ask'>) =>
    http.post('/datasets/:id/ask', { params: { id }, body }),
  postChartsData: (id: string) => http.post('/charts/:id/data', { params: { id }, body: {} }),
  postMetricsValue: (id: string, body: ApiBody<'POST /metrics/:id/value'>) =>
    http.post('/metrics/:id/value', { params: { id }, body }),
}
