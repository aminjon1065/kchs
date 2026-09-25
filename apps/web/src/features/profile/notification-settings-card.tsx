import {
  type DeliveryMode,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
  type PresenceState,
  type TelegramStatus,
} from '@kchs/contracts'
import {
  Button,
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Moon } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { PresenceDialog } from '~/features/chat/chat-dialogs.js'
import { chatKeys } from '~/features/chat/queries.js'
import { ApiError, http } from '~/shared/api/client.js'
import { pushStatusQuery } from '~/shared/push/client.js'

const preferencesKey = ['me', 'notification-preferences'] as const

/** Что умеет канал: сводка по почте есть, в приложении и мессенджерах — только сразу или никак. */
const CHANNEL_MODES: Record<NotificationChannel, readonly DeliveryMode[]> = {
  app: ['immediate', 'off'],
  email: ['immediate', 'digest', 'off'],
  telegram: ['immediate', 'off'],
  push: ['immediate', 'off'],
}

/**
 * Уведомления по категориям и каналам (ADR-0153): в приложении, почта, Telegram, push —
 * сразу, сводкой (почта) или выключено. Telegram и push недоступны, пока канал не
 * подключён в карточках ниже. Тихие часы и «не беспокоить» глушат внешние каналы у всех
 * категорий, кроме срочного (ADR-0140), — они живут в статусе присутствия.
 */
export function NotificationSettingsCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [presence, setPresence] = useState(false)
  const { data } = useQuery({
    queryKey: preferencesKey,
    queryFn: () => http.get<NotificationPreferences>('/me/notification-preferences'),
  })
  const telegram = useQuery({
    queryKey: ['me', 'telegram'],
    queryFn: () => http.get<TelegramStatus>('/me/telegram'),
  })
  const push = useQuery(pushStatusQuery)
  // Диалог статуса берёт начальные значения из кэша: открываем его только с данными,
  // иначе «Сохранить» записало бы тихие часы по умолчанию поверх настроенных
  const presenceState = useQuery({
    queryKey: chatKeys.presence,
    queryFn: () => http.get<PresenceState>('/me/presence'),
  })

  const update = useMutation({
    mutationFn: (input: {
      category: NotificationCategory
      channel: NotificationChannel
      mode: DeliveryMode
    }) => http.put('/me/notification-preferences', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: preferencesKey }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!data) return null
  const available: Record<NotificationChannel, boolean> = {
    app: true,
    email: true,
    telegram: Boolean(telegram.data?.enabled && telegram.data.linked),
    push: Boolean(push.data?.enabled && push.data.devices > 0),
  }
  const modeOf = (category: NotificationCategory, channel: NotificationChannel): DeliveryMode =>
    data.items.find((item) => item.category === category && item.channel === channel)?.mode ??
    data.defaults.find((item) => item.category === category && item.channel === channel)?.mode ??
    'off'

  return (
    <Card title={t('notifications.settings')} padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-fg-muted">
              <th scope="col" className="px-4 py-2 font-medium">
                {t('notifications.settingsCategory')}
              </th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} scope="col" className="px-2 py-2 font-medium">
                  <span className="block">{t(`notifications.channel.${channel}`)}</span>
                  {available[channel] ? null : (
                    <span className="block font-normal text-fg-muted">
                      {t('notifications.channelUnavailable')}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {NOTIFICATION_CATEGORIES.map((category) => (
              <tr key={category}>
                <th scope="row" className="px-4 py-1.5 text-left font-normal text-fg">
                  {t(`notifications.category.${category}`)}
                </th>
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <td key={channel} className="px-2 py-1.5">
                    <Select
                      value={modeOf(category, channel)}
                      disabled={!available[channel] || update.isPending}
                      onValueChange={(mode) =>
                        update.mutate({ category, channel, mode: mode as DeliveryMode })
                      }
                    >
                      <SelectTrigger
                        className="h-7 w-32 text-xs"
                        aria-label={t('notifications.settingsCell', {
                          category: t(`notifications.category.${category}`),
                          channel: t(`notifications.channel.${channel}`),
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CHANNEL_MODES[channel].map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`notifications.mode.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        <p className="min-w-0 flex-1 text-xs text-fg-secondary">{t('notifications.quietHint')}</p>
        <Button
          variant="secondary"
          size="sm"
          icon={<Moon className="size-3.5" />}
          disabled={!presenceState.data}
          onClick={() => setPresence(true)}
        >
          {t('notifications.quietEdit')}
        </Button>
      </div>
      {presence && presenceState.data ? (
        <PresenceDialog onClose={() => setPresence(false)} />
      ) : null}
    </Card>
  )
}
