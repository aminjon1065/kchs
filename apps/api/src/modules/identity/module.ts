import type { RouteRegistrar } from '~/shared/http/route.js'
import { registerAuthRoutes } from './http/auth-routes.js'
import { registerMeRoutes } from './http/me-routes.js'
import { registerOrgRoutes } from './http/org-routes.js'
import { registerSecurityRoutes } from './http/security-routes.js'

export function registerIdentityRoutes(route: RouteRegistrar): void {
  registerAuthRoutes(route)
  registerMeRoutes(route)
  registerOrgRoutes(route)
  registerSecurityRoutes(route)
}
