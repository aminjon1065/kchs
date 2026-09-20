import type { MeetingRecord, ProtocolRecord, ProtocolResponse } from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'

/** Ключи кэша протокола: карточка встречи, сам протокол. */
export const protocolKeys = {
  meeting: (id: string) => ['meeting', id] as const,
  ofMeeting: (id: string) => ['meeting', id, 'protocol'] as const,
  protocol: (id: string) => ['protocol', id] as const,
}

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.meeting(id),
    queryFn: () => http.get<MeetingRecord>(`/meetings/${id}`),
  })

/** Протокол встречи; null — его ещё не завели. */
export const meetingProtocolQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.ofMeeting(id),
    queryFn: async () => (await http.get<ProtocolResponse>(`/meetings/${id}/protocol`)).protocol,
  })

/**
 * Снимок протокола: состояние поручений и права. Тело правится совместно, а
 * состояния поручений меняются вне протокола — поэтому снимок перечитывается.
 */
export const protocolQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.protocol(id),
    queryFn: () => http.get<ProtocolRecord>(`/protocols/${id}`),
    staleTime: 10_000,
  })
