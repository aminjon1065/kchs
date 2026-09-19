import type {
  CorrespondentList,
  CorrespondentRecord,
  DocumentRecord,
  DocumentSummary,
  DocumentTypeRecord,
  DocumentVersionList,
  JournalRecord,
  JournalReservationList,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/**
 * Ключи кэша документооборота. Карточка и версии — под `['object', id, …]`:
 * realtime ядра инвалидирует `['object', id]` при любом изменении документа.
 */
export const documentKeys = {
  all: ['documents'] as const,
  summary: ['documents', 'summary'] as const,
  document: (id: string) => ['object', id, 'document'] as const,
  versions: (id: string) => ['object', id, 'versions'] as const,
  types: (includeInactive: boolean) => ['documents', 'types', includeInactive] as const,
  journals: (includeInactive: boolean) => ['documents', 'journals', includeInactive] as const,
  reservations: (journalId: string) => ['object', journalId, 'reservations'] as const,
  correspondents: (q: string) => ['documents', 'correspondents', q] as const,
  correspondent: (id: string) => ['object', id, 'correspondent'] as const,
}

export const documentQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.document(id),
    queryFn: () => http.get<DocumentRecord>(`/documents/${id}`),
  })

export const documentVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.versions(id),
    queryFn: async () => (await http.get<DocumentVersionList>(`/documents/${id}/versions`)).items,
  })

export const documentSummaryQuery = () =>
  queryOptions({
    queryKey: documentKeys.summary,
    queryFn: () => http.get<DocumentSummary>('/documents/summary'),
    staleTime: 30_000,
  })

export const documentTypesQuery = (includeInactive = false) =>
  queryOptions({
    queryKey: documentKeys.types(includeInactive),
    queryFn: async () =>
      (
        await http.get<{ items: DocumentTypeRecord[] }>('/document-types', {
          query: { includeInactive: includeInactive ? 'true' : undefined },
        })
      ).items,
    staleTime: 5 * 60_000,
  })

export const journalsQuery = (includeInactive = false) =>
  queryOptions({
    queryKey: documentKeys.journals(includeInactive),
    queryFn: async () =>
      (
        await http.get<{ items: JournalRecord[] }>('/journals', {
          query: { includeInactive: includeInactive ? 'true' : undefined },
        })
      ).items,
    staleTime: 60_000,
  })

export const journalReservationsQuery = (journalId: string) =>
  queryOptions({
    queryKey: documentKeys.reservations(journalId),
    queryFn: async () =>
      (await http.get<JournalReservationList>(`/journals/${journalId}/reservations`)).items,
  })

export const correspondentsQuery = (q: string) =>
  queryOptions({
    queryKey: documentKeys.correspondents(q),
    queryFn: () =>
      http.get<CorrespondentList>('/correspondents', { query: { q: q || undefined, limit: 50 } }),
  })

export const correspondentQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.correspondent(id),
    queryFn: () => http.get<CorrespondentRecord>(`/correspondents/${id}`),
  })
