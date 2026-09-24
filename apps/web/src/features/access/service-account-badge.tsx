import { Badge } from '@kchs/ui'
import { Bot } from 'lucide-react'
import { useT } from '~/app/i18n.js'

/**
 * Отметка служебной учётной записи (ADR-0130) в списках людей и выдаче доступа:
 * от её имени работают правила и интеграции, войти ею нельзя.
 */
export function ServiceAccountBadge() {
  const t = useT()
  return (
    <Badge size="sm" tone="neutral" title={t('access.serviceAccount.hint')}>
      <Bot className="size-3" aria-hidden />
      {t('access.serviceAccount.label')}
    </Badge>
  )
}
