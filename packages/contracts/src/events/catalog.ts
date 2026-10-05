import type { z } from 'zod'
import { ACKNOWLEDGMENT_EVENTS } from './acknowledgment.js'
import { ALERTS_EVENTS } from './alerts.js'
import { AUTOMATION_EVENTS } from './automation.js'
import { CALENDAR_EVENTS } from './calendar.js'
import { CHAT_EVENTS } from './chat.js'
import { DATA_EVENTS } from './data.js'
import { DIRECTORY_EVENTS } from './directory.js'
import { DISCUSSION_EVENTS } from './discussion.js'
import { DOCUMENTS_EVENTS } from './documents.js'
import { FILES_EVENTS } from './files.js'
import { FORMS_EVENTS } from './forms.js'
import { GIS_EVENTS } from './gis.js'
import { INTEGRATIONS_EVENTS } from './integrations.js'
import { JOB_EVENTS } from './job.js'
import { KNOWLEDGE_EVENTS } from './knowledge.js'
import { MAIL_EVENTS } from './mail.js'
import { MEETINGS_EVENTS } from './meetings.js'
import { NOTIFICATION_EVENTS } from './notification.js'
import { OBJECT_EVENTS } from './object.js'
import { PROCESS_EVENTS } from './process.js'
import { REPORTS_EVENTS } from './reports.js'
import { SETTINGS_EVENTS } from './settings.js'
import { SPACE_EVENTS } from './space.js'
import { TASKS_EVENTS } from './tasks.js'
import { TERRITORIES_EVENTS } from './territories.js'

/**
 * Части каталога доменных событий (16-api-and-events.md §2, ADR-0189): у каждого модуля и
 * области ядра — свой файл с нагрузками своих доменов, поэтому работа над разными модулями не
 * правит один общий файл. Домен события (часть типа до точки, поток шины `events:<домен>`)
 * целиком принадлежит одной части, а тип события не повторяется в двух — это проверяет тест
 * каталога (спред молча перекрыл бы повтор).
 */
export const EVENT_CATALOG_PARTS = {
  object: OBJECT_EVENTS,
  directory: DIRECTORY_EVENTS,
  space: SPACE_EVENTS,
  discussion: DISCUSSION_EVENTS,
  notification: NOTIFICATION_EVENTS,
  job: JOB_EVENTS,
  process: PROCESS_EVENTS,
  acknowledgment: ACKNOWLEDGMENT_EVENTS,
  settings: SETTINGS_EVENTS,
  files: FILES_EVENTS,
  data: DATA_EVENTS,
  reports: REPORTS_EVENTS,
  forms: FORMS_EVENTS,
  alerts: ALERTS_EVENTS,
  gis: GIS_EVENTS,
  territories: TERRITORIES_EVENTS,
  tasks: TASKS_EVENTS,
  calendar: CALENDAR_EVENTS,
  meetings: MEETINGS_EVENTS,
  chat: CHAT_EVENTS,
  knowledge: KNOWLEDGE_EVENTS,
  documents: DOCUMENTS_EVENTS,
  mail: MAIL_EVENTS,
  automation: AUTOMATION_EVENTS,
  integrations: INTEGRATIONS_EVENTS,
} as const

/**
 * Каталог доменных событий. Регистрация типа события без схемы полезной нагрузки
 * запрещена — `publishEvent` отказывает событию вне каталога.
 */
export const EVENT_PAYLOADS = {
  ...OBJECT_EVENTS,
  ...DIRECTORY_EVENTS,
  ...SPACE_EVENTS,
  ...DISCUSSION_EVENTS,
  ...NOTIFICATION_EVENTS,
  ...JOB_EVENTS,
  ...PROCESS_EVENTS,
  ...ACKNOWLEDGMENT_EVENTS,
  ...SETTINGS_EVENTS,
  ...FILES_EVENTS,
  ...DATA_EVENTS,
  ...REPORTS_EVENTS,
  ...FORMS_EVENTS,
  ...ALERTS_EVENTS,
  ...GIS_EVENTS,
  ...TERRITORIES_EVENTS,
  ...TASKS_EVENTS,
  ...CALENDAR_EVENTS,
  ...MEETINGS_EVENTS,
  ...CHAT_EVENTS,
  ...KNOWLEDGE_EVENTS,
  ...DOCUMENTS_EVENTS,
  ...MAIL_EVENTS,
  ...AUTOMATION_EVENTS,
  ...INTEGRATIONS_EVENTS,
} as const satisfies Record<string, z.ZodType>

export type EventType = keyof typeof EVENT_PAYLOADS
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[]

/**
 * Домены событий каталога — потоки шины `events:<домен>` (ADR-0182). Событие вне
 * каталога не публикуется, поэтому других потоков у шины не бывает.
 */
export const EVENT_DOMAINS: readonly string[] = [
  ...new Set(EVENT_TYPES.map((type) => type.split('.')[0] ?? '')),
].sort()

/**
 * Версия нагрузки типа события (contracts/events.md, ADR-0189): уходит в конверт и к
 * получателям вебхуков. Ломающее изменение схемы — удалённое или переименованное поле,
 * другой тип поля, новое обязательное поле — повышает версию здесь; проверка
 * совместимости контрактов (`pnpm contracts:compat`) не пропустит его без этого. Тип, которого
 * здесь нет, — версии 1.
 */
export const EVENT_VERSIONS: Partial<Record<EventType, number>> = {}

/** Текущая версия нагрузки события. */
export function eventVersion(type: EventType): number {
  return EVENT_VERSIONS[type] ?? 1
}

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export function isKnownEventType(type: string): type is EventType {
  return type in EVENT_PAYLOADS
}
