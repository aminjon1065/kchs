import { registerJobHandler } from '~/kernel/jobs/runner.js'
import { systemCtx } from '~/shared/context.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DirectorySync } from './domain/directory-sync.js'
import { APPLY_JOB, UsersImport } from './domain/users-import.js'
import { registerAuthRoutes } from './http/auth-routes.js'
import { registerDirectoryRoutes } from './http/directory-routes.js'
import { registerMeRoutes } from './http/me-routes.js'
import { registerOrgRoutes } from './http/org-routes.js'
import { registerPasskeyRoutes } from './http/passkey-routes.js'
import { registerSecurityRoutes } from './http/security-routes.js'
import { registerServiceAccountRoutes } from './http/service-account-routes.js'
import { registerSsoRoutes } from './http/sso-routes.js'
import { registerUsersImportRoutes } from './http/users-import-routes.js'

export function registerIdentityRoutes(route: RouteRegistrar): void {
  registerAuthRoutes(route)
  registerMeRoutes(route)
  registerOrgRoutes(route)
  registerServiceAccountRoutes(route)
  registerSecurityRoutes(route)
  registerUsersImportRoutes(route)
  registerDirectoryRoutes(route)
  registerSsoRoutes(route)
  registerPasskeyRoutes(route)
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

  /**
   * Синхронизация каталога по расписанию (ADR-0098). Задание запускается раз в
   * час, а интервал задаёт администратор: так один повторяемый job обслуживает
   * любое значение настройки, и менять расписание BullMQ не приходится.
   */
  registerJobHandler({
    queue: 'maintenance',
    name: 'directory.sync',
    concurrency: 1,
    handle: async () => {
      if (!(await DirectorySync.due())) return { skipped: true }
      const run = await DirectorySync.run(systemCtx('directory.schedule'), 'scheduled')
      return { status: run.status, ...run.stats }
    },
  })
}
