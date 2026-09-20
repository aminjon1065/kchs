import type {
  MeetingGuestJoin,
  MeetingGuestJoinInput,
  MeetingGuestPreview,
  MeetingJoin,
  MeetingKnockList,
  MeetingList,
  MeetingRecord,
  MeetingsStatus,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша встреч (01-project-structure.md §apps/web). */
export const meetingKeys = {
  status: ['meetings', 'status'] as const,
  list: (scope: string) => ['meetings', 'list', scope] as const,
  meeting: (id: string) => ['meeting', id] as const,
  knocks: (id: string) => ['meeting', id, 'knocks'] as const,
  guest: (token: string) => ['meeting', 'guest', token] as const,
}

/** Медиасервер настроен: иначе кнопок звонка и входа нет (ADR-0089). */
export const meetingsStatusQuery = () =>
  queryOptions({
    queryKey: meetingKeys.status,
    queryFn: () => http.get<MeetingsStatus>('/meetings/status'),
    staleTime: 5 * 60_000,
  })

export const meetingsQuery = (scope: 'mine' | 'live' | 'all') =>
  queryOptions({
    queryKey: meetingKeys.list(scope),
    queryFn: () => http.get<MeetingList>('/meetings', { query: { scope } }),
  })

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: meetingKeys.meeting(id),
    queryFn: () => http.get<MeetingRecord>(`/meetings/${id}`),
    enabled: Boolean(id),
  })

/** Ожидающие в комнате — только тому, кто ведёт встречу. */
export const meetingKnocksQuery = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: meetingKeys.knocks(id),
    queryFn: () => http.get<MeetingKnockList>(`/meetings/${id}/knocks`),
    enabled: enabled && Boolean(id),
    refetchInterval: 15_000,
  })

export const joinMeeting = (id: string) => http.post<MeetingJoin>(`/meetings/${id}/join`)
export const leaveMeeting = (id: string) => http.post<{ ok: true }>(`/meetings/${id}/leave`)
export const endMeeting = (id: string) => http.post<MeetingRecord>(`/meetings/${id}/end`)
export const declineCall = (id: string) => http.post<{ ok: true }>(`/meetings/${id}/decline`)
export const decideKnock = (id: string, requestId: string, admit: boolean) =>
  http.post<{ ok: true }>(`/meetings/${id}/knocks/${requestId}`, { admit })

/** Гостевая ссылка: вход без учётной записи, ограниченный срок (ADR-0091). */
export const guestPreview = (token: string) =>
  http.get<MeetingGuestPreview>(`/meetings/guest/${encodeURIComponent(token)}`, {
    anonymous: true,
  })

export const guestJoin = (token: string, input: MeetingGuestJoinInput) =>
  http.post<MeetingGuestJoin>(`/meetings/guest/${encodeURIComponent(token)}/join`, input, {
    anonymous: true,
  })
