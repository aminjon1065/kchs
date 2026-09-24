import {
  ServiceAccount,
  ServiceAccountCreateInput,
  ServiceAccountPatchInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { hasCapability } from '~/kernel/access/authorize.js'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { ServiceAccountService } from '../domain/service-accounts.js'

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
    method: 'GET',
    url: '/service-accounts',
    auth: 'session',
    tags: ['org'],
    summary: 'Служебные учётные записи',
    schema: { response: { 200: z.object({ items: z.array(ServiceAccount) }) } },
    handler: async (request) => {
      assertCanList(request.ctx)
      return { items: await ServiceAccountService.list() }
    },
  })

  route({
    method: 'GET',
    url: '/service-accounts/:id',
    auth: 'session',
    tags: ['org'],
    summary: 'Служебная учётная запись',
    schema: { params: z.object({ id: z.uuid() }), response: { 200: ServiceAccount } },
    handler: async (request) => {
      assertCanList(request.ctx)
      return ServiceAccountService.get(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/service-accounts',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Завести служебную учётную запись',
    schema: { body: ServiceAccountCreateInput, response: { 200: ServiceAccount } },
    handler: async (request) => {
      const id = await db().transaction((tx) =>
        ServiceAccountService.create(tx, request.ctx, request.body),
      )
      return ServiceAccountService.get(id)
    },
  })

  route({
    method: 'PATCH',
    url: '/service-accounts/:id',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Изменить служебную учётную запись',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: ServiceAccountPatchInput,
      response: { 200: ServiceAccount },
    },
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
