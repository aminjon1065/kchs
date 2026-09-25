import { registerSubscriber } from '~/kernel/events/bus.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { MailProvisioning } from './domain/provisioning.js'
import { registerMailRoutes } from './http/routes.js'

/**
 * Почта установки (ADR-0150). Файл учёток почтового сервера переписывается, когда меняется
 * состав сотрудников или пароль для почты: заблокированный теряет вход сразу, новый
 * сотрудник получает ящик.
 */
export function registerMailBackground(): void {
  registerSubscriber({
    name: 'mail-provisioning',
    types: ['user.created', 'user.blocked', 'user.updated', 'mail.password_changed'],
    handle: async () => {
      if (MailProvisioning.enabled()) await MailProvisioning.sync()
    },
  })
}

export function registerMailModuleRoutes(route: RouteRegistrar): void {
  registerMailRoutes(route)
}
