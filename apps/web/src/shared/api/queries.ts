import type {
  ActiveDelegation,
  Activity,
  AdminUser,
  AuditEntry,
  EffectiveAccess,
  FileRecord,
  FileVersion,
  HealthReport,
  InboxCounts,
  InboxItem,
  JobRecord,
  Level,
  LinkView,
  MeResponse,
  Message,
  Notification,
  ObjectRecord,
  ObjectSummary,
  OrgUnit,
  PrincipalRef,
  RoleInfo,
  SearchResponse,
  SecurityPolicy,
  ShareLinkList,
  Space,
  SpaceMember,
  TagListResponse,
  TagView,
} from '@kchs/contracts'
import { type QueryClient, queryOptions } from '@tanstack/react-query'
import { http } from './client.js'

/** Ключи кэша: `['objectType', id, …]` (01-project-structure.md §apps/web). */
export const keys = {
  me: ['me'] as const,
  spaces: ['spaces'] as const,
  space: (id: string) => ['space', id] as const,
  spaceMembers: (id: string) => ['space', id, 'members'] as const,
  object: (id: string) => ['object', id] as const,
  objectList: (params: Record<string, unknown>) => ['objects', params] as const,
  objectLinks: (id: string) => ['object', id, 'links'] as const,
  objectActivity: (id: string) => ['object', id, 'activity'] as const,
  objectAccess: (id: string) => ['object', id, 'access'] as const,
  shareLinks: (id: string) => ['object', id, 'share-links'] as const,
  discussion: (id: string) => ['object', id, 'discussion'] as const,
  inbox: (params: Record<string, unknown>) => ['inbox', params] as const,
  inboxCounts: ['inbox', 'counts'] as const,
  notifications: (unreadOnly: boolean) => ['notifications', unreadOnly] as const,
  search: (params: Record<string, unknown>) => ['search', params] as const,
  favorites: ['favorites'] as const,
  recent: ['recent'] as const,
  trash: ['trash'] as const,
  file: (id: string) => ['file', id] as const,
  fileVersions: (id: string) => ['file', id, 'versions'] as const,
  // Под ключом объекта: realtime `object.updated` (превью готово) сбрасывает их сам
  filePreviews: (id: string) => ['object', id, 'previews'] as const,
  fileText: (id: string) => ['object', id, 'text'] as const,
  users: (params: Record<string, unknown>) => ['users', params] as const,
  orgUnits: ['org', 'units'] as const,
  audit: (params: Record<string, unknown>) => ['admin', 'audit', params] as const,
  health: ['admin', 'health'] as const,
  jobs: ['jobs'] as const,
  delegations: ['me', 'delegations'] as const,
  workspaceState: ['me', 'workspace-state'] as const,
  principals: (q: string, types: string) => ['principals', q, types] as const,
  tags: (spaceId: string | null, q: string) => ['tags', spaceId, q] as const,
  roles: ['roles'] as const,
  securityPolicy: ['admin', 'security-policy'] as const,
}

export const meQuery = () =>
  queryOptions({
    queryKey: keys.me,
    queryFn: () => http.get<MeResponse>('/me'),
    staleTime: 60_000,
    retry: false,
  })

export const spacesQuery = () =>
  queryOptions({
    queryKey: keys.spaces,
    queryFn: () => http.get<{ items: Space[] }>('/spaces'),
    select: (data: { items: Space[] }) => data.items,
    staleTime: 30_000,
  })

export const spaceMembersQuery = (id: string) =>
  queryOptions({
    queryKey: keys.spaceMembers(id),
    queryFn: () => http.get<{ items: SpaceMember[] }>(`/spaces/${id}/members`),
    select: (data: { items: SpaceMember[] }) => data.items,
  })

export const objectQuery = (id: string) =>
  queryOptions({
    queryKey: keys.object(id),
    queryFn: () => http.get<ObjectRecord>(`/objects/${id}`),
  })

export interface ObjectListParams extends Record<string, unknown> {
  spaceId?: string
  parentId?: string
  type?: string
  types?: string
  q?: string
  lifecycle?: 'active' | 'archived' | 'trashed' | 'any'
  limit?: number
  cursor?: string
}

export const objectListQuery = (params: ObjectListParams) =>
  queryOptions({
    queryKey: keys.objectList(params),
    queryFn: () =>
      http.get<{ items: ObjectSummary[]; nextCursor: string | null }>('/objects', {
        query: params as Record<string, string | number | undefined>,
      }),
  })

export const objectLinksQuery = (id: string) =>
  queryOptions({
    queryKey: keys.objectLinks(id),
    queryFn: () =>
      http.get<{ links: LinkView[]; uses: ObjectSummary[]; usedBy: ObjectSummary[] }>(
        `/objects/${id}/links`,
      ),
  })

export const objectActivityQuery = (id: string) =>
  queryOptions({
    queryKey: keys.objectActivity(id),
    queryFn: () =>
      http.get<{ items: Activity[]; nextCursor: string | null }>(`/objects/${id}/activity`),
    // Лента строится из событий асинхронно — при открытии панели всегда свежая
    staleTime: 0,
    refetchOnMount: 'always',
  })

export const objectAccessQuery = (id: string) =>
  queryOptions({
    queryKey: keys.objectAccess(id),
    queryFn: () =>
      http.get<{
        entries: EffectiveAccess[]
        accessMode: 'inherit' | 'restricted'
        canManage: boolean
      }>(`/objects/${id}/access`),
  })

export const discussionQuery = (id: string) =>
  queryOptions({
    queryKey: keys.discussion(id),
    queryFn: () =>
      http.get<{
        conversation: { id: string; unreadCount: number } | null
        items: Message[]
        nextCursor: string | null
      }>(`/objects/${id}/discussion`),
  })

export const inboxQuery = (params: { state?: string; scope?: string; kind?: string }) =>
  queryOptions({
    queryKey: keys.inbox(params),
    queryFn: () =>
      http.get<{ items: InboxItem[]; nextCursor: string | null }>('/inbox', { query: params }),
  })

export const inboxCountsQuery = () =>
  queryOptions({
    queryKey: keys.inboxCounts,
    queryFn: () => http.get<InboxCounts>('/inbox/counts'),
    staleTime: 15_000,
  })

export const notificationsQuery = (unreadOnly = false) =>
  queryOptions({
    queryKey: keys.notifications(unreadOnly),
    queryFn: () =>
      http.get<{ items: Notification[]; nextCursor: string | null; unread: number }>(
        '/notifications',
        { query: { unreadOnly } },
      ),
  })

export const searchQuery = (params: { q: string; types?: string; limit?: number }) =>
  queryOptions({
    queryKey: keys.search(params),
    queryFn: () => http.get<SearchResponse>('/search', { query: params }),
    enabled: params.q.length > 0,
    staleTime: 10_000,
  })

export const favoritesQuery = () =>
  queryOptions({
    queryKey: keys.favorites,
    queryFn: () => http.get<{ items: ObjectSummary[] }>('/me/favorites'),
    select: (data: { items: ObjectSummary[] }) => data.items,
  })

export const recentQuery = () =>
  queryOptions({
    queryKey: keys.recent,
    queryFn: () => http.get<{ items: ObjectSummary[] }>('/me/recent', { query: { limit: 12 } }),
    select: (data: { items: ObjectSummary[] }) => data.items,
  })

export const trashQuery = () =>
  queryOptions({
    queryKey: keys.trash,
    queryFn: () => http.get<{ items: ObjectSummary[] }>('/trash'),
    select: (data: { items: ObjectSummary[] }) => data.items,
  })

export const fileQuery = (id: string) =>
  queryOptions({ queryKey: keys.file(id), queryFn: () => http.get<FileRecord>(`/files/${id}`) })

export const fileVersionsQuery = (id: string) =>
  queryOptions({
    queryKey: keys.fileVersions(id),
    queryFn: () => http.get<{ items: FileVersion[] }>(`/files/${id}/versions`),
    select: (data: { items: FileVersion[] }) => data.items,
  })

export const usersQuery = (params: { q?: string; limit?: number; status?: string }) =>
  queryOptions({
    queryKey: keys.users(params),
    queryFn: () =>
      http.get<{ items: AdminUser[]; nextCursor: string | null }>('/users', { query: params }),
  })

export const orgUnitsQuery = () =>
  queryOptions({
    queryKey: keys.orgUnits,
    queryFn: () => http.get<{ items: OrgUnit[] }>('/org/units'),
    select: (data: { items: OrgUnit[] }) => data.items,
  })

export const auditQuery = (params: Record<string, string | number | undefined>) =>
  queryOptions({
    queryKey: keys.audit(params),
    queryFn: () =>
      http.get<{ items: AuditEntry[]; nextCursor: string | null }>('/admin/audit', {
        query: params,
      }),
  })

export const healthQuery = () =>
  queryOptions({
    queryKey: keys.health,
    queryFn: () => http.get<HealthReport>('/admin/health'),
    refetchInterval: 30_000,
  })

export const jobsQuery = () =>
  queryOptions({
    queryKey: keys.jobs,
    queryFn: () => http.get<{ items: JobRecord[] }>('/jobs'),
    select: (data: { items: JobRecord[] }) => data.items,
  })

export const delegationsQuery = () =>
  queryOptions({
    queryKey: keys.delegations,
    queryFn: () => http.get<{ items: ActiveDelegation[] }>('/me/delegations'),
    select: (data: { items: ActiveDelegation[] }) => data.items,
  })

export const principalsQuery = (q: string, types = 'user,group,unit,position') =>
  queryOptions({
    queryKey: keys.principals(q, types),
    queryFn: () =>
      http.get<{ items: PrincipalRef[] }>('/principals/search', { query: { q, types, limit: 20 } }),
    select: (data: { items: PrincipalRef[] }) => data.items,
    enabled: q.length > 0,
  })

export const shareLinksQuery = (objectId: string) =>
  queryOptions({
    queryKey: keys.shareLinks(objectId),
    queryFn: () => http.get<ShareLinkList>(`/objects/${objectId}/share-links`),
  })

export const rolesQuery = () =>
  queryOptions({
    queryKey: keys.roles,
    queryFn: () => http.get<{ items: RoleInfo[] }>('/roles'),
    select: (data: { items: RoleInfo[] }) => data.items,
    staleTime: 60_000,
  })

export const securityPolicyQuery = () =>
  queryOptions({
    queryKey: keys.securityPolicy,
    queryFn: () => http.get<SecurityPolicy>('/admin/security-policy'),
  })

/** Подсказки тегов: словарь пространства объекта и общие теги. */
export const tagSuggestionsQuery = (spaceId: string | null, q: string) =>
  queryOptions({
    queryKey: keys.tags(spaceId, q),
    queryFn: () =>
      http.get<TagListResponse>('/tags', { query: { spaceId: spaceId ?? undefined, q } }),
    select: (data: TagListResponse): TagView[] => data.items,
    staleTime: 30_000,
  })

/** Инвалидация по realtime-событию `object.updated`. */
export function invalidateObject(client: QueryClient, objectId: string): void {
  void client.invalidateQueries({ queryKey: ['object', objectId] })
  void client.invalidateQueries({ queryKey: ['objects'] })
}

export type { Level }
