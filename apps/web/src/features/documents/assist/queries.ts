import type { DocumentAssistStatus } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Доступность ИИ по документу; пока текст скана распознаётся — опрос раз в 3 с. */
export const documentAssistQuery = (id: string) =>
  queryOptions({
    queryKey: ['object', id, 'document-assist'] as const,
    queryFn: () => http.get<DocumentAssistStatus>(`/documents/${id}/assist`),
    refetchInterval: (query) => (query.state.data?.blocker === 'text_pending' ? 3000 : false),
    staleTime: 10_000,
  })

/** Тон уверенности модели: уверенно, проверьте, сомнительно. */
export function confidenceTone(confidence: number): 'success' | 'warning' | 'danger' {
  if (confidence >= 0.8) return 'success'
  if (confidence >= 0.5) return 'warning'
  return 'danger'
}
