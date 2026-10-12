import type { DeviceLinkState } from '@kchs/contracts'
import { Badge, type BadgeProps } from '@kchs/ui'
import { useT } from '~/shared/i18n.js'

const TONE: Record<DeviceLinkState, NonNullable<BadgeProps['tone']>> = {
  online: 'success',
  stale: 'warning',
  never: 'neutral',
}

/** Связь устройства: «на связи», «нет связи», «не выходило». */
export function LinkBadge({ link }: { link: DeviceLinkState }) {
  const t = useT()
  return (
    <Badge tone={TONE[link]} size="sm">
      {t(`positions.links.${link}`)}
    </Badge>
  )
}
