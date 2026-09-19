import type {
  BusinessCalendarYear,
  CalendarFeed,
  CalendarList,
  CalendarListQuery,
  CalendarProjectionSource,
  CalendarRange,
  CalendarRecord,
  CalendarSettings,
  EventRecord,
  FreeBusyResult,
} from '@kchs/contracts'
import { keepPreviousData, queryOptions, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { http } from '~/shared/api/client.js'

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
        await http.get<CalendarList>('/calendars', {
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
    queryFn: () => http.get<CalendarRecord>(`/calendars/${id}`),
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
      http.get<CalendarRange>('/calendar/range', {
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
    queryFn: () => http.get<CalendarRange>('/calendar/today'),
    staleTime: 60_000,
  })

export const calendarSettingsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.settings,
    queryFn: () => http.get<CalendarSettings>('/calendar/settings'),
    staleTime: 60_000,
  })

export const projectionSourcesQuery = () =>
  queryOptions({
    queryKey: calendarKeys.projections,
    queryFn: async () =>
      (await http.get<{ items: CalendarProjectionSource[] }>('/calendar/projections')).items,
    staleTime: 5 * 60_000,
  })

export const eventQuery = (id: string, recurrenceId?: string | null) =>
  queryOptions({
    queryKey: calendarKeys.event(id, recurrenceId),
    queryFn: () =>
      http.get<EventRecord>(`/events/${id}`, {
        query: recurrenceId ? { recurrenceId } : {},
      }),
  })

export const feedsQuery = (calendarId: string) =>
  queryOptions({
    queryKey: calendarKeys.feeds(calendarId),
    queryFn: async () =>
      (await http.get<{ items: CalendarFeed[] }>(`/calendars/${calendarId}/feeds`)).items,
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
      http.get<FreeBusyResult>('/calendar/free-busy', {
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
    queryFn: () =>
      http.get<BusinessCalendarYear>('/business-calendar', { query: { year: String(year) } }),
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
