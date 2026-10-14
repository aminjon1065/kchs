import type { QualifiedSignatureAuthority } from '~/kernel/signature/port.js'
import * as A from './asn1.js'
import { PkiAuthority } from './authority.js'
import { PkiCertificates } from './certificates.js'

/**
 * УЦ Комитета как поставщик порта квалифицированной подписи (ADR-0218): ключ сотрудника —
 * на его устройстве, CMS собирает платформа, штамп времени — служба самой платформы,
 * проверка — по корню Комитета со списками отзыва, встроенными в документ (PAdES-B-LT).
 */
export async function committeeAuthority(): Promise<QualifiedSignatureAuthority | null> {
  const status = await PkiAuthority.status()
  if (!status.initialized) return null
  const { issuing, root } = await PkiAuthority.chain()
  const [issuingCrl, rootCrl] = await Promise.all([
    PkiAuthority.crl('issuing'),
    PkiAuthority.crl('root'),
  ])
  return {
    kind: 'device-key',
    integrationId: null,
    name: 'УЦ Комитета',
    agentUrl: null,
    timestamp: { url: '/api/v1/pki/tsa', username: null, password: null },
    policy: {
      trustRootsPem: [A.pem('CERTIFICATE', root)],
      revocation: 'hard-fail',
      fetchRevocation: false,
      crls: [issuingCrl.toString('base64'), rootCrl.toString('base64')],
      ltv: true,
    },
    device: {
      signedAttributes: (certificateDer, digest) => A.signedAttributes(certificateDer, digest),
      assemble: async (certificateDer, digest, signature) =>
        A.assembleCms({ certificateDer, chainDer: [issuing], digest, signature }),
      owner: (certificateDer) => PkiCertificates.owner(certificateDer),
    },
  }
}
