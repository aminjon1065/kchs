import { hasCapability } from '~/kernel/access/authorize.js'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ServiceAccountService } from './service-accounts.js'

/**
 * Служебные записи видят те, кто ведёт людей, и те, кто ведёт правила: второму
 * список нужен для выбора `run_as`, заводить записи он не может.
 */
function assertCanList(ctx: UserCtx): void {
  if (hasCapability(ctx, 'users.manage') || hasCapability(ctx, 'automation.manage')) return
  throw errors.forbidden('Служебные учётные записи видят администраторы людей и правил')
}

/** Служебные учётные записи (ADR-0130): консоль и выбор `run_as` правил. */
export function registerServiceAccountRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /service-accounts',
    auth: 'session',
    tags: ['org'],
    summary: 'Служебные учётные записи',
    handler: async (request) => {
      assertCanList(request.ctx)
      return { items: await ServiceAccountService.list() }
    },
  })

  route({
    route: 'GET /service-accounts/:id',
    auth: {
      delegated: 'assertCanList: users.manage или automation.manage',
      resource: 'service_account',
    },
    tags: ['org'],
    summary: 'Служебная учётная запись',
    handler: async (request) => {
      assertCanList(request.ctx)
      return ServiceAccountService.get(request.params.id)
    },
  })

  route({
    route: 'POST /service-accounts',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Завести служебную учётную запись',
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        ServiceAccountService.create(tx, request.ctx, request.body),
      )
      return ServiceAccountService.get(id)
    },
  })

  route({
    route: 'PATCH /service-accounts/:id',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Изменить служебную учётную запись',
    handler: async (request) => {
      await db().transaction((tx) =>
        ServiceAccountService.update(tx, request.ctx, request.params.id, request.body),
      )
      // После коммита: новые роли и пространства действуют со следующего запуска правила
      await invalidatePrincipalSet(request.params.id)
      return ServiceAccountService.get(request.params.id)
    },
  })
}
