import type {
  CaseList,
  CaseListQuery,
  CaseRecord,
  CaseSuggestions,
  CorrespondenceChain,
  CorrespondentList,
  CorrespondentRecord,
  DestructionActList,
  DocumentDispatchList,
  DocumentNumberPreview,
  DocumentRecord,
  DocumentResolutions,
  DocumentRouteOptions,
  DocumentRouteStepVersions,
  DocumentSignatureList,
  DocumentSummary,
  DocumentTypeRecord,
  DocumentVersionList,
  JournalRecord,
  JournalReservationList,
  ObjectAcknowledgments,
  ResolutionTemplate,
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
  routes: (id: string) => ['object', id, 'document-routes'] as const,
  routeVersions: (id: string) => ['object', id, 'route-versions'] as const,
  signatures: (id: string) => ['object', id, 'signatures'] as const,
  resolutions: (id: string) => ['object', id, 'resolutions'] as const,
  acknowledgments: (id: string) => ['object', id, 'acknowledgments'] as const,
  resolutionTemplates: ['documents', 'resolution-templates'] as const,
  // Дела и переписка (ADR-0086)
  cases: (query: CaseListQuery) => ['documents', 'cases', query] as const,
  case: (id: string) => ['object', id, 'case'] as const,
  caseSuggestions: (id: string, purpose: 'filing' | 'registration' = 'filing') =>
    ['object', id, 'case-suggestions', purpose] as const,
  numberPreview: (id: string, journalId: string, caseId: string) =>
    ['object', id, 'number-preview', journalId, caseId] as const,
  dispatches: (id: string) => ['object', id, 'dispatches'] as const,
  correspondence: (id: string) => ['object', id, 'correspondence'] as const,
  destructionActs: ['documents', 'destruction-acts'] as const,
  office: ['documents', 'office'] as const,
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

/** Маршруты, по которым можно отправить документ (ADR-0083). */
export const documentRoutesQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.routes(id),
    queryFn: () => http.get<DocumentRouteOptions>(`/documents/${id}/routes`),
  })

/** Какую версию видел каждый шаг согласования и подписи. */
export const documentRouteVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.routeVersions(id),
    queryFn: async () =>
      new Map(
        (await http.get<DocumentRouteStepVersions>(`/documents/${id}/route-versions`)).items.map(
          (item) => [item.stepId, item.versionNumber] as const,
        ),
      ),
  })

export const documentSignaturesQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.signatures(id),
    queryFn: async () =>
      (await http.get<DocumentSignatureList>(`/documents/${id}/signatures`)).items,
  })

/** Резолюции документа, направления на резолюцию и права смотрящего (ADR-0084). */
export const resolutionsQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.resolutions(id),
    queryFn: () => http.get<DocumentResolutions>(`/documents/${id}/resolutions`),
  })

/** Ознакомление с объектом — механизм ядра (ADR-0084). */
export const acknowledgmentsQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.acknowledgments(id),
    queryFn: () => http.get<ObjectAcknowledgments>(`/objects/${id}/acknowledgments`),
  })

export const resolutionTemplatesQuery = () =>
  queryOptions({
    queryKey: documentKeys.resolutionTemplates,
    queryFn: async () =>
      (await http.get<{ items: ResolutionTemplate[] }>('/resolution-templates')).items,
    staleTime: 5 * 60_000,
  })

export const casesQuery = (query: CaseListQuery = {}) =>
  queryOptions({
    queryKey: documentKeys.cases(query),
    queryFn: async () =>
      (
        await http.get<CaseList>('/cases', {
          query: {
            year: query.year,
            status: query.status,
            unitId: query.unitId,
            q: query.q || undefined,
          },
        })
      ).items,
  })

export const caseQuery = (id: string) =>
  queryOptions({
    queryKey: documentKeys.case(id),
    queryFn: () => http.get<CaseRecord>(`/cases/${id}`),
  })

export const caseSuggestionsQuery = (
  documentId: string,
  purpose: 'filing' | 'registration' = 'filing',
) =>
  queryOptions({
    queryKey: documentKeys.caseSuggestions(documentId, purpose),
    queryFn: () =>
      http.get<CaseSuggestions>(`/documents/${documentId}/cases`, { query: { purpose } }),
  })

/** Каким будет номер при регистрации: журнал и дело (`none` — без дела, `auto` — подбор). */
export const numberPreviewQuery = (documentId: string, journalId: string, caseId: string) =>
  queryOptions({
    queryKey: documentKeys.numberPreview(documentId, journalId, caseId),
    queryFn: () =>
      http.get<DocumentNumberPreview>(`/documents/${documentId}/number-preview`, {
        query: { journalId, ...(caseId === 'auto' ? {} : { caseId }) },
      }),
  })

export const dispatchesQuery = (documentId: string) =>
  queryOptions({
    queryKey: documentKeys.dispatches(documentId),
    queryFn: async () =>
      (await http.get<DocumentDispatchList>(`/documents/${documentId}/dispatches`)).items,
  })

export const correspondenceQuery = (documentId: string) =>
  queryOptions({
    queryKey: documentKeys.correspondence(documentId),
    queryFn: () => http.get<CorrespondenceChain>(`/documents/${documentId}/correspondence`),
  })

export const destructionActsQuery = () =>
  queryOptions({
    queryKey: documentKeys.destructionActs,
    queryFn: async () => (await http.get<DestructionActList>('/cases/destruction-acts')).items,
  })

/** Дашборд «Канцелярия», если он заведён и виден пользователю (ADR-0086). */
export const officeDashboardQuery = () =>
  queryOptions({
    queryKey: documentKeys.office,
    queryFn: () => http.get<{ dashboardId: string | null }>('/documents/office'),
    staleTime: 5 * 60_000,
  })
