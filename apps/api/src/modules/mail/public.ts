/**
 * Публичный API модуля «Почта» (ADR-0150): отправитель исходящих документов — ящик
 * канцелярии своего почтового сервера; синхронизация ящиков для `kchs mail sync`.
 */
import { MailProvisioning } from './domain/provisioning.js'

/** @public — ящик канцелярии для исходящих и синхронизация ящиков */
export const MailPublic = {
  enabled: (): boolean => MailProvisioning.enabled(),
  registrySender: () => MailProvisioning.registrySender(),
  registry: () => MailProvisioning.registry(),
  sync: () => MailProvisioning.sync(),
}
