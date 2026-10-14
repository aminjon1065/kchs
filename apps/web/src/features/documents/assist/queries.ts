import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/** Доступность ИИ по документу; пока текст скана распознаётся — опрос раз в 3 с. */
export const documentAssistQuery = (id: string) =>
  queryOptions({
    queryKey: ['object', id, 'document-assist'] as const,
    queryFn: () => http.get('/documents/:id/assist', { params: { id } }),
    refetchInterval: (query) => (query.state.data?.blocker === 'text_pending' ? 3000 : false),
    staleTime: 10_000,
  })

/** Тон уверенности модели: уверенно, проверьте, сомнительно. */
export function confidenceTone(confidence: number): 'success' | 'warning' | 'danger' {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.5) return 'warning'
  return 'danger'
}

export const documentsAssistApi = {
  postAssistSummary: (id: string) => http.post('/documents/:id/assist/summary', { params: { id } }),
  patch: (id: string, body: ApiBody<'PATCH /documents/:id'>) =>
    http.patch('/documents/:id', { params: { id }, body }),
  postAssistReply: (id: string, body: ApiBody<'POST /documents/:id/assist/reply'>) =>
    http.post('/documents/:id/assist/reply', { params: { id }, body }),
}
