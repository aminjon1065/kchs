import { MailPassword, MailStatus } from '@kchs/contracts'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MailProvisioning } from '../domain/provisioning.js'

/** Почта сотрудника в профиле (ADR-0150): адрес ящика, веб-почта, пароль для почты. */
export function registerMailRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/me/mail',
    auth: 'session',
    tags: ['me'],
    summary: 'Почтовый ящик сотрудника в почте установки',
    schema: { response: { 200: MailStatus } },
    handler: async (request) => MailProvisioning.status(request.ctx),
  })

  route({
    method: 'POST',
    url: '/me/mail/password',
    auth: 'session',
    tags: ['me'],
    summary: 'Новый пароль для почты: показывается один раз, прежний перестаёт действовать',
    schema: { response: { 200: MailPassword } },
    handler: async (request) => MailProvisioning.setPassword(request.ctx),
  })

  route({
    method: 'DELETE',
    url: '/me/mail/password',
    auth: 'session',
    tags: ['me'],
    summary: 'Отозвать пароль для почты: ящик принимает письма, войти в него нельзя',
    schema: { response: { 200: MailStatus } },
    handler: async (request) => {
      await MailProvisioning.revokePassword(request.ctx)
      return MailProvisioning.status(request.ctx)
    },
  })
}
