import type { CalendarListQuery } from '@kchs/contracts'
import { keepPreviousData, queryOptions, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { http } from '~/shared/api/client.js'
import type { ApiBody, ApiQuery } from '~/shared/api/route-types.js'

/**
 * Ключи кэша календаря. Событие и календарь — под `['object', id, …]`:
 * realtime ядра сбрасывает их при изменении объекта; диапазоны — под
 * `['calendar', …]`, их сбрасывает `calendar.changed`.
 */
export const calendarKeys = {
  all: ['calendar'] as const,
  list: (query: Partial<CalendarListQuery>) => ['calendar', 'list', query] as const,
  range: (params: Record<string, unknown>) => ['calendar', 'range', params] as const,
  today: ['calendar', 'today'] as const,
  settings: ['calendar', 'settings'] as const,
  projections: ['calendar', 'projections'] as const,
  freeBusy: (params: Record<string, unknown>) => ['calendar', 'free-busy', params] as const,
  businessYear: (year: number) => ['calendar', 'business', year] as const,
  calendar: (id: string) => ['object', id, 'calendar'] as const,
  feeds: (id: string) => ['object', id, 'calendar-feeds'] as const,
  event: (id: string, recurrenceId?: string | null) =>
    ['object', id, 'event', recurrenceId ?? null] as const,
}

export const calendarsQuery = (query: Partial<CalendarListQuery> = { scope: 'mine' }) =>
  queryOptions({
    queryKey: calendarKeys.list(query),
    queryFn: async () =>
      (
        await http.get('/calendars', {
          query: {
            scope: query.scope ?? 'mine',
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.q ? { q: query.q } : {}),
          },
        })
      ).items,
    staleTime: 30_000,
  })

export const calendarQuery = (id: string) =>
  queryOptions({
    queryKey: calendarKeys.calendar(id),
    queryFn: () => http.get('/calendars/:id', { params: { id } }),
  })

export interface RangeParams {
  from: string
  to: string
  calendarIds?: string[]
  projections?: string[]
}

export const rangeQuery = (params: RangeParams) =>
  queryOptions({
    queryKey: calendarKeys.range({ ...params }),
    queryFn: () =>
      http.get('/calendar/range', {
        query: {
          from: params.from,
          to: params.to,
          ...(params.calendarIds ? { calendarIds: params.calendarIds.join(',') } : {}),
          ...(params.projections ? { projections: params.projections.join(',') } : {}),
        },
      }),
    // Переход по неделям не мигает пустой сеткой
    placeholderData: keepPreviousData,
  })

export const todayQuery = () =>
  queryOptions({
    queryKey: calendarKeys.today,
    queryFn: () => http.get('/calendar/today'),
    staleTime: 60_000,
  })

export const calendarSettingsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.settings,
    queryFn: () => http.get('/calendar/settings'),
    staleTime: 60_000,
  })

export const projectionSourcesQuery = () =>
  queryOptions({
    queryKey: calendarKeys.projections,
    queryFn: async () => (await http.get('/calendar/projections')).items,
    staleTime: 5 * 60_000,
  })

export const eventQuery = (id: string, recurrenceId?: string | null) =>
  queryOptions({
    queryKey: calendarKeys.event(id, recurrenceId),
    queryFn: () =>
      http.get('/events/:id', { params: { id }, query: recurrenceId ? { recurrenceId } : {} }),
  })

export const feedsQuery = (calendarId: string) =>
  queryOptions({
    queryKey: calendarKeys.feeds(calendarId),
    queryFn: async () =>
      (await http.get('/calendars/:id/feeds', { params: { id: calendarId } })).items,
  })

export interface FreeBusyParams {
  from: string
  to: string
  userIds: string[]
  resourceIds: string[]
  excludeEventId?: string | null
}

export const freeBusyQuery = (params: FreeBusyParams) =>
  queryOptions({
    queryKey: calendarKeys.freeBusy({ ...params }),
    queryFn: () =>
      http.get('/calendar/free-busy', {
        query: {
          from: params.from,
          to: params.to,
          ...(params.userIds.length ? { userIds: params.userIds.join(',') } : {}),
          ...(params.resourceIds.length ? { resourceIds: params.resourceIds.join(',') } : {}),
          ...(params.excludeEventId ? { excludeEventId: params.excludeEventId } : {}),
        },
      }),
    placeholderData: keepPreviousData,
  })

/** Производственный календарь года: праздники, переносы, рабочие субботы. */
export const businessYearQuery = (year: number) =>
  queryOptions({
    queryKey: calendarKeys.businessYear(year),
    queryFn: () => http.get('/business-calendar', { query: { year: String(year) } }),
    staleTime: 60 * 60_000,
  })

/** После правки события: диапазоны, «Сегодня», Входящие и карточка события. */
export function useCalendarInvalidation(): (eventId?: string) => void {
  const client = useQueryClient()
  return useCallback(
    (eventId?: string) => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      void client.invalidateQueries({ queryKey: ['inbox'] })
      if (eventId) void client.invalidateQueries({ queryKey: ['object', eventId] })
    },
    [client],
  )
}

export const calendarApi = {
  createCalendar: (body: ApiBody<'POST /calendars'>) => http.post('/calendars', { body }),
  putSettings: (body: ApiBody<'PUT /calendar/settings'>) =>
    http.put('/calendar/settings', { body }),
  patchCalendars: (id: string, body: ApiBody<'PATCH /calendars/:id'>) =>
    http.patch('/calendars/:id', { params: { id }, body }),
  postCalendarsFeeds: (id: string) => http.post('/calendars/:id/feeds', { params: { id } }),
  removeCalendarsFeeds: (id: string, feedId: string) =>
    http.delete('/calendars/:id/feeds/:feedId', { params: { id, feedId } }),
  postCalendarsImport: (id: string, body: ApiBody<'POST /calendars/:id/import'>) =>
    http.post('/calendars/:id/import', { params: { id }, body }),
  patchEvents: (id: string, body: ApiBody<'PATCH /events/:id'>) =>
    http.patch('/events/:id', { params: { id }, body }),
  postCalendarsSync: (id: string) => http.post('/calendars/:id/sync', { params: { id } }),
  postEventsRespond: (id: string, body: ApiBody<'POST /events/:id/respond'>) =>
    http.post('/events/:id/respond', { params: { id }, body }),
  postEventsCancel: (id: string, body: ApiBody<'POST /events/:id/cancel'>) =>
    http.post('/events/:id/cancel', { params: { id }, body }),
  getPrincipalsSearch: (query: ApiQuery<'GET /principals/search'>) =>
    http.get('/principals/search', { query }),
  createEvent: (body: ApiBody<'POST /events'>) => http.post('/events', { body }),
  postFindTime: (body: ApiBody<'POST /calendar/find-time'>) =>
    http.post('/calendar/find-time', { body }),
}

export const meetingsStatusQuery = () =>
  queryOptions({
    queryKey: ['meetings', 'status'],
    queryFn: () => http.get('/meetings/status'),
  })
