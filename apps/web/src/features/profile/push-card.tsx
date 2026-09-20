import { Button, Callout, Card, cn, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import {
  deviceSubscribed,
  PUSH_SUPPORTED,
  pushStatusQuery,
  subscribeDevice,
  unsubscribeDevice,
} from '~/shared/push/client.js'

const deviceKey = ['me', 'push', 'device'] as const

/**
 * Push в профиле (P4-E02 S08, ADR-0094): подписка этого устройства на
 * уведомления браузера. Без ключей установки и в браузере без поддержки
 * карточки нет; категории каналов — общие настройки уведомлений.
 */
export function PushCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()

  const status = useQuery(pushStatusQuery)
  const device = useQuery({
    queryKey: deviceKey,
    queryFn: deviceSubscribed,
    enabled: PUSH_SUPPORTED,
  })

  const subscribe = useMutation({
    mutationFn: async () => subscribeDevice(status.data?.publicKey ?? ''),
    onSuccess: (outcome) => {
      if (outcome === 'denied') {
        toast.show({ title: t('profile.push.denied'), tone: 'warning' })
        return
      }
      toast.show({ title: t('profile.push.subscribed'), tone: 'success' })
      void client.invalidateQueries({ queryKey: deviceKey })
      void client.invalidateQueries({ queryKey: pushStatusQuery.queryKey })
    },
    onError: () => toast.show({ title: t('profile.push.failed'), tone: 'danger' }),
  })

  const unsubscribe = useMutation({
    mutationFn: unsubscribeDevice,
    onSuccess: () => {
      toast.show({ title: t('profile.push.unsubscribed'), tone: 'success' })
      void client.invalidateQueries({ queryKey: deviceKey })
      void client.invalidateQueries({ queryKey: pushStatusQuery.queryKey })
    },
  })

  if (!status.data?.enabled) return null
  const here = device.data ?? false
  const blocked = PUSH_SUPPORTED && Notification.permission === 'denied'

  return (
    <Card title={t('profile.push.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-secondary">{t('profile.push.description')}</p>
        {PUSH_SUPPORTED ? null : <Callout tone="info">{t('profile.push.unsupported')}</Callout>}
        {blocked ? <Callout tone="warning">{t('profile.push.blocked')}</Callout> : null}
        <div className="flex items-center gap-3">
          <BellRing
            className={cn('size-5 shrink-0', here ? 'text-success' : 'text-fg-muted')}
            aria-hidden
          />
          <p className="min-w-0 flex-1 text-sm text-fg">
            {here ? t('profile.push.deviceOn') : t('profile.push.deviceOff')}
            <span className="ml-1.5 text-xs text-fg-muted">
              {t('profile.push.devices', { count: status.data.devices })}
            </span>
          </p>
          {here ? (
            <Button
              variant="secondary"
              loading={unsubscribe.isPending}
              onClick={() => unsubscribe.mutate()}
            >
              {t('profile.push.disable')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!PUSH_SUPPORTED || blocked}
              loading={subscribe.isPending}
              onClick={() => subscribe.mutate()}
            >
              {t('profile.push.enable')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}
