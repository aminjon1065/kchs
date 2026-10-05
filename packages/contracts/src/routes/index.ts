import { mergeRouteTables } from '../http/route-contract.js'
import { kernelAccessRoutes } from './kernel/access.js'
import { kernelAcknowledgmentsRoutes } from './kernel/acknowledgments.js'
import { kernelAnnouncementsRoutes } from './kernel/announcements.js'
import { kernelBusinessCalendarRoutes } from './kernel/business-calendar.js'
import { kernelDirectoryRoutes } from './kernel/directory.js'
import { kernelDiscussionsRoutes } from './kernel/discussions.js'
import { kernelEventsRoutes } from './kernel/events.js'
import { kernelInboxRoutes } from './kernel/inbox.js'
import { kernelJobsRoutes } from './kernel/jobs.js'
import { kernelNotificationsRoutes } from './kernel/notifications.js'
import { kernelObjectsRoutes } from './kernel/objects.js'
import { kernelSchedulesRoutes } from './kernel/schedules.js'
import { kernelSearchRoutes } from './kernel/search.js'
import { kernelSpacesRoutes } from './kernel/spaces.js'
import { kernelTagsRoutes } from './kernel/tags.js'
import { kernelViewsRoutes } from './kernel/views.js'
import { adminRoutes } from './modules/admin.js'
import { aiRoutes } from './modules/ai.js'
import { alertsRoutes } from './modules/alerts.js'
import { assistantRoutes } from './modules/assistant.js'
import { automationRoutes } from './modules/automation.js'
import { calendarRoutes } from './modules/calendar.js'
import { chatRoutes } from './modules/chat.js'
import { dataRoutes } from './modules/data.js'
import { documentsRoutes } from './modules/documents.js'
import { filesRoutes } from './modules/files.js'
import { formsRoutes } from './modules/forms.js'
import { gisRoutes } from './modules/gis.js'
import { identityRoutes } from './modules/identity.js'
import { integrationsRoutes } from './modules/integrations.js'
import { knowledgeRoutes } from './modules/knowledge.js'
import { mailRoutes } from './modules/mail.js'
import { meetingsRoutes } from './modules/meetings.js'
import { pushRoutes } from './modules/push.js'
import { reportsRoutes } from './modules/reports.js'
import { tasksRoutes } from './modules/tasks.js'
import { telegramRoutes } from './modules/telegram.js'
import { territoriesRoutes } from './modules/territories.js'

/**
 * Маршруты HTTP API, описанные в контрактах (ADR-0188): ядро и модули, по таблице
 * на владельца. Маршруты движка процессов описывает пакет `@kchs/process`
 * (`processRoutes`, `documentProcessRoutes`): их схемы стоят на определении
 * процесса (ADR-0079). Полная таблица для api и клиента — `routes` и тип `Routes` из
 * `@kchs/process/routes`.
 */
export type ApiRoutes = typeof kernelAccessRoutes &
  typeof kernelAcknowledgmentsRoutes &
  typeof kernelAnnouncementsRoutes &
  typeof kernelBusinessCalendarRoutes &
  typeof kernelDirectoryRoutes &
  typeof kernelDiscussionsRoutes &
  typeof kernelEventsRoutes &
  typeof kernelInboxRoutes &
  typeof kernelJobsRoutes &
  typeof kernelNotificationsRoutes &
  typeof kernelObjectsRoutes &
  typeof kernelSchedulesRoutes &
  typeof kernelSearchRoutes &
  typeof kernelSpacesRoutes &
  typeof kernelTagsRoutes &
  typeof kernelViewsRoutes &
  typeof adminRoutes &
  typeof aiRoutes &
  typeof alertsRoutes &
  typeof assistantRoutes &
  typeof automationRoutes &
  typeof calendarRoutes &
  typeof chatRoutes &
  typeof dataRoutes &
  typeof documentsRoutes &
  typeof filesRoutes &
  typeof formsRoutes &
  typeof gisRoutes &
  typeof identityRoutes &
  typeof integrationsRoutes &
  typeof knowledgeRoutes &
  typeof mailRoutes &
  typeof meetingsRoutes &
  typeof pushRoutes &
  typeof reportsRoutes &
  typeof tasksRoutes &
  typeof telegramRoutes &
  typeof territoriesRoutes

export const apiRoutes: ApiRoutes = mergeRouteTables(
  kernelAccessRoutes,
  kernelAcknowledgmentsRoutes,
  kernelAnnouncementsRoutes,
  kernelBusinessCalendarRoutes,
  kernelDirectoryRoutes,
  kernelDiscussionsRoutes,
  kernelEventsRoutes,
  kernelInboxRoutes,
  kernelJobsRoutes,
  kernelNotificationsRoutes,
  kernelObjectsRoutes,
  kernelSchedulesRoutes,
  kernelSearchRoutes,
  kernelSpacesRoutes,
  kernelTagsRoutes,
  kernelViewsRoutes,
  adminRoutes,
  aiRoutes,
  alertsRoutes,
  assistantRoutes,
  automationRoutes,
  calendarRoutes,
  chatRoutes,
  dataRoutes,
  documentsRoutes,
  filesRoutes,
  formsRoutes,
  gisRoutes,
  identityRoutes,
  integrationsRoutes,
  knowledgeRoutes,
  mailRoutes,
  meetingsRoutes,
  pushRoutes,
  reportsRoutes,
  tasksRoutes,
  telegramRoutes,
  territoriesRoutes,
)
