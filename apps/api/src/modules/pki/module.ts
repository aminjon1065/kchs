import { registerAuditActions } from '~/kernel/audit/registry.js'
import { registerSubscriber } from '~/kernel/events/bus.js'
import { setQualifiedSignatureProvider } from '~/kernel/signature/port.js'
import { systemCtx } from '~/shared/context.js'
import { PKI_AUDIT } from './domain/audit-actions.js'
import { PkiCertificates } from './domain/certificates.js'
import { committeeAuthority } from './domain/provider.js'

export { registerPkiRoutes } from './http/routes.js'

/**
 * УЦ Комитета (ADR-0218): поставщик порта квалифицированной подписи ядра — по умолчанию,
 * если внешний УЦ (`qes_ca`) не настроен.
 */
export function registerPkiProvider(): void {
  registerAuditActions('pki', PKI_AUDIT)
  setQualifiedSignatureProvider('pki', { authority: committeeAuthority })
}

/** Заблокированный сотрудник больше не подписывает: его сертификаты отзываются. */
export function registerPkiBackground(): void {
  registerSubscriber({
    name: 'pki-revoke-blocked',
    types: ['user.blocked'],
    handle: async (event) => {
      const userId = event.object?.id
      if (!userId) return
      await PkiCertificates.revokeAllOf(
        systemCtx('pki.user-blocked'),
        userId,
        'учётная запись заблокирована',
      )
    },
  })
}
