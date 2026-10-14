import { queryOptions } from '@tanstack/react-query'
import { http } from '~/shared/api/client.js'
import type { ApiBody } from '~/shared/api/route-types.js'

/** Ключи кэша протокола: карточка встречи, сам протокол. */
export const protocolKeys = {
  meeting: (id: string) => ['meeting', id] as const,
  ofMeeting: (id: string) => ['meeting', id, 'protocol'] as const,
  protocol: (id: string) => ['protocol', id] as const,
  acknowledgments: (id: string) => ['protocol', id, 'acknowledgments'] as const,
}

export const meetingQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.meeting(id),
    queryFn: () => http.get('/meetings/:id', { params: { id } }),
  })

/** Протокол встречи; null — его ещё не завели. */
export const meetingProtocolQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.ofMeeting(id),
    queryFn: async () => (await http.get('/meetings/:id/protocol', { params: { id } })).protocol,
  })

/**
 * Снимок протокола: состояние поручений и права. Тело правится совместно, а
 * состояния поручений меняются вне протокола — поэтому снимок перечитывается.
 */
export const protocolQuery = (id: string) =>
  queryOptions({
    queryKey: protocolKeys.protocol(id),
    queryFn: () => http.get('/protocols/:id', { params: { id } }),
    staleTime: 10_000,
  })

export const meetingsProtocolApi = {
  postProtocol: (id: string) => http.post('/meetings/:id/protocol', { params: { id } }),
  postProtocolsDraft: (id: string) => http.post('/protocols/:id/draft', { params: { id } }),
  postProtocolsConfirm: (id: string) => http.post('/protocols/:id/confirm', { params: { id } }),
  postProtocolsAcknowledgments: (id: string) =>
    http.post('/protocols/:id/acknowledgments', { params: { id }, body: {} }),
  postProtocolsRegister: (id: string, body: ApiBody<'POST /protocols/:id/register'>) =>
    http.post('/protocols/:id/register', { params: { id }, body }),
  postProtocolsPrint: (id: string) => http.post('/protocols/:id/print', { params: { id } }),
  getObjectsAcknowledgments: (id: string) =>
    http.get('/objects/:id/acknowledgments', { params: { id } }),
  postObjectsAcknowledgmentsAcknowledge: (id: string) =>
    http.post('/objects/:id/acknowledgments/acknowledge', { params: { id }, body: {} }),
}
