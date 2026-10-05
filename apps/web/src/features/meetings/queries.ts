import type { MeetingGuestJoinInput } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша встреч (01-project-structure.md §apps/web). */
export const meetingKeys = {
  status: ['meetings', 'status'] as const,
  list: (scope: string) => ['meetings', 'list', scope] as const,
  meeting: (id: string) => ['meeting', id] as const,
  knocks: (id: string) => ['meeting', id, 'knocks'] as const,
  recordings: (id: string) => ['meeting', id, 'recordings'] as const,
  guest: (token: string) => ['meeting', 'guest', token] as const,
}

/** Медиасервер настроен: иначе кнопок звонка и входа нет (ADR-0089). */
export const meetingsStatusQuery = () =>
  queryOptions({
    queryKey: meetingKeys.status,
    queryFn: () => http.get('/meetings/status'),
    staleTime: 5 * 60_000,
  })

export const meetingsQuery = (scope: 'mine' | 'live' | 'all') =>
  queryOptions({
    queryKey: meetingKeys.list(scope),
    queryFn: () => http.get('/meetings', { query: { scope } }),
  })

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: meetingKeys.meeting(id),
    queryFn: () => http.get('/meetings/:id', { params: { id } }),
    enabled: Boolean(id),
  })

/** Ожидающие в комнате — только тому, кто ведёт встречу. */
export const meetingKnocksQuery = (id: string, enabled: boolean) =>
  queryOptions({
    queryKey: meetingKeys.knocks(id),
    queryFn: () => http.get('/meetings/:id/knocks', { params: { id } }),
    enabled: enabled && Boolean(id),
    refetchInterval: 15_000,
  })

export const joinMeeting = (id: string) => http.post('/meetings/:id/join', { params: { id } })
export const leaveMeeting = (id: string) => http.post('/meetings/:id/leave', { params: { id } })
export const endMeeting = (id: string) => http.post('/meetings/:id/end', { params: { id } })
export const declineCall = (id: string) => http.post('/meetings/:id/decline', { params: { id } })
export const decideKnock = (id: string, requestId: string, admit: boolean) =>
  http.post('/meetings/:id/knocks/:requestId', { params: { id, requestId }, body: { admit } })

/** Гостевая ссылка: вход без учётной записи, ограниченный срок (ADR-0091). */
export const guestPreview = (token: string) =>
  http.get('/meetings/guest/:token', { params: { token }, anonymous: true })

export const guestJoin = (token: string, input: MeetingGuestJoinInput) =>
  http.post('/meetings/guest/:token/join', { params: { token }, body: input, anonymous: true })
