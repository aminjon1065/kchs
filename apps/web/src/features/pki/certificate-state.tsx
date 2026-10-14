import type { PkiCertificateState } from '@kchs/contracts'
import { Badge } from '@kchs/ui'
import { useT } from '~/shared/i18n.js'

const TONES = { active: 'success', revoked: 'danger', expired: 'neutral' } as const

/** Состояние сертификата УЦ Комитета: действует, отозван, истёк. */
export function CertificateStateBadge({ state }: { state: PkiCertificateState }) {
  const t = useT()
  return (
    <Badge size="sm" tone={TONES[state]}>
      {t(`profile.signingKey.states.${state}`)}
    </Badge>
  )
}
