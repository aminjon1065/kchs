import { z } from 'zod'
import {
  CalendarCreateInput,
  CalendarFeed,
  CalendarFeedCreated,
  CalendarImportInput,
  CalendarImportResult,
  CalendarList,
  CalendarListQuery,
  CalendarProjectionSource,
  CalendarRecord,
  CalendarSettings,
  CalendarSettingsInput,
  CalendarUpdateInput,
} from '../../calendar/calendar.js'
import {
  CalendarRange,
  CalendarRangeQuery,
  EventCancelInput,
  EventCreateInput,
  EventRecord,
  EventRemindersInput,
  EventRespondInput,
  EventUpdateInput,
  FindTimeInput,
  FindTimeResult,
  FreeBusyQuery,
  FreeBusyResult,
} from '../../calendar/event.js'
import { Timestamp } from '../../common/primitives.js'
import { defineRoutes } from '../../http/route-contract.js'
import { IdParam } from '../params.js'

/**
 * Маршруты модуля «calendar» (ADR-0188). Регистрация — `apps/api/src/modules/calendar/`:
 * http.ts.
 */
export const calendarRoutes = defineRoutes({
  'GET /calendars': { query: CalendarListQuery, response: { 200: CalendarList } },
  'POST /calendars': { body: CalendarCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /calendars/:id': { params: IdParam, response: { 200: CalendarRecord } },
  'PATCH /calendars/:id': {
    params: IdParam,
    body: CalendarUpdateInput,
    response: { 200: CalendarRecord },
  },
  'POST /calendars/:id/import': {
    params: IdParam,
    body: CalendarImportInput,
    response: { 200: CalendarImportResult },
  },
  'POST /calendars/:id/sync': { params: IdParam, response: { 200: z.object({ jobId: z.uuid() }) } },
  'GET /calendars/:id/feeds': {
    params: IdParam,
    response: { 200: z.object({ items: z.array(CalendarFeed) }) },
  },
  'POST /calendars/:id/feeds': { params: IdParam, response: { 200: CalendarFeedCreated } },
  'DELETE /calendars/:id/feeds/:feedId': {
    params: z.object({ id: z.uuid(), feedId: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'GET /calendar-feeds/:file': { params: z.object({ file: z.string().max(200) }) },
  'GET /calendar/settings': { response: { 200: CalendarSettings } },
  'PUT /calendar/settings': { body: CalendarSettingsInput, response: { 200: CalendarSettings } },
  'GET /calendar/projections': {
    response: { 200: z.object({ items: z.array(CalendarProjectionSource) }) },
  },
  'GET /calendar/range': { query: CalendarRangeQuery, response: { 200: CalendarRange } },
  'GET /calendar/today': { response: { 200: CalendarRange } },
  'GET /calendar/free-busy': { query: FreeBusyQuery, response: { 200: FreeBusyResult } },
  'POST /calendar/find-time': { body: FindTimeInput, response: { 200: FindTimeResult } },
  'POST /events': { body: EventCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
  'GET /events/:id': {
    params: IdParam,
    query: z.object({ recurrenceId: Timestamp.optional() }),
    response: { 200: EventRecord },
  },
  'PATCH /events/:id': {
    params: IdParam,
    body: EventUpdateInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'POST /events/:id/cancel': {
    params: IdParam,
    body: EventCancelInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
  'POST /events/:id/respond': {
    params: IdParam,
    body: EventRespondInput,
    response: { 200: EventRecord },
  },
  'PUT /events/:id/my-reminders': {
    params: IdParam,
    body: EventRemindersInput,
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
