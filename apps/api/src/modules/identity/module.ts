import { registerJobHandler } from '~/kernel/jobs/runner.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { APPLY_JOB, UsersImport } from './domain/users-import.js'
import { registerAuthRoutes } from './http/auth-routes.js'
import { registerMeRoutes } from './http/me-routes.js'
import { registerOrgRoutes } from './http/org-routes.js'
import { registerSecurityRoutes } from './http/security-routes.js'
import { registerUsersImportRoutes } from './http/users-import-routes.js'

export function registerIdentityRoutes(route: RouteRegistrar): void {
  registerAuthRoutes(route)
  registerMeRoutes(route)
  registerOrgRoutes(route)
  registerSecurityRoutes(route)
  registerUsersImportRoutes(route)
}

/** Обработчики заданий модуля — только в роли worker. */
export function registerIdentityBackground(): void {
  registerJobHandler({
    queue: APPLY_JOB.queue,
    name: APPLY_JOB.name,
    // Импорты одного администратора идут по очереди: создание и так параллельно внутри
    concurrency: 1,
    handle: async (job, helpers) => UsersImport.run(job.data, helpers.progress),
  })
}
