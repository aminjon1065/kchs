import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerAccessRoutes } from './access/http.js'
import { registerAcknowledgmentRoutes } from './acknowledgments/http.js'
import { registerAnnouncementRoutes } from './announcements/http.js'
import { registerBusinessCalendarRoutes } from './business-calendar/http.js'
import { registerDiscussionRoutes } from './discussions/http.js'
import { registerInboxRoutes } from './inbox/http.js'
import { registerJobRoutes } from './jobs/http.js'
import { registerInternalJobRoutes } from './jobs/internal-http.js'
import { registerNotificationRoutes } from './notifications/http.js'
import { registerObjectRoutes } from './objects/http.js'
import { registerProcessRoutes } from './process/http.js'
import { registerScheduleRoutes } from './schedules/http.js'
import { registerSearchRoutes } from './search/http.js'
import { registerSpaceRoutes } from './spaces/http.js'
import { registerTagRoutes } from './tags/http.js'
import { registerViewRoutes } from './views/http.js'

export function registerKernelRoutes(route: RouteRegistrar): void {
  registerObjectRoutes(route)
  registerAccessRoutes(route)
  registerSpaceRoutes(route)
  registerSearchRoutes(route)
  registerDiscussionRoutes(route)
  registerNotificationRoutes(route)
  registerInboxRoutes(route)
  registerJobRoutes(route)
  registerInternalJobRoutes(route)
  registerViewRoutes(route)
  registerTagRoutes(route)
  registerAnnouncementRoutes(route)
  registerBusinessCalendarRoutes(route)
  registerProcessRoutes(route)
  registerAcknowledgmentRoutes(route)
  registerScheduleRoutes(route)
}
