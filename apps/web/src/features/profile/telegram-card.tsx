import type { TelegramLinkStart, TelegramStatus } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { Button, Callout, Card, cn, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'

const statusKey = ['me', 'telegram'] as const

/**
 * Telegram в профиле (P1-E09 S01, ADR-0061): одноразовая ссылка на бота,
 * ожидание привязки, отвязка и выбор категорий уведомлений для Telegram.
 * Без токена бота на установке карточки нет.
 */
export function TelegramCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const [pending, setPending] = useState<TelegramLinkStart | null>(null)

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => http.get<TelegramStatus>('/me/telegram'),
    // Пока пользователь открывает бота, привязку ждём опросом
    refetchInterval: pending ? 3000 : false,
  })
  const linked = status.data?.linked ?? false

  useEffect(() => {
    if (pending && linked) {
      setPending(null)
      toast.show({ title: t('profile.telegram.connected'), tone: 'success' })
    }
  }, [pending, linked, toast, t])

  const link = useMutation({
    mutationFn: () => http.post<TelegramLinkStart>('/me/telegram/link'),
    onSuccess: setPending,
    onError: () => toast.show({ title: t('profile.telegram.unavailable'), tone: 'danger' }),
  })

  const unlink = useMutation({
    mutationFn: () => http.delete<{ ok: boolean }>('/me/telegram'),
    onSuccess: () => {
      toast.show({ title: t('profile.telegram.disconnected'), tone: 'success' })
      void client.invalidateQueries({ queryKey: statusKey })
    },
  })

  if (!status.data?.enabled) return null
  const { username, linkedAt } = status.data

  return (
    <Card title={t('profile.telegram.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-secondary">{t('profile.telegram.description')}</p>
        <div className="flex items-center gap-3">
          <Send
            className={cn('size-5 shrink-0', linked ? 'text-success' : 'text-fg-muted')}
            aria-hidden
          />
          <p className="min-w-0 flex-1 text-sm text-fg">
            {linked
              ? username
                ? t('profile.telegram.linkedAs', { username })
                : t('profile.telegram.linked')
              : t('profile.telegram.notLinked')}
            {linked && linkedAt ? (
              <span className="ml-1.5 text-xs text-fg-muted">
                {t('profile.telegram.since', { date: formatDate(linkedAt, { locale }) })}
              </span>
            ) : null}
          </p>
          {linked ? (
            <Button
              variant="secondary"
              size="sm"
              loading={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              {t('profile.telegram.disconnect')}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={link.isPending}
              onClick={() => link.mutate()}
            >
              {t('profile.telegram.connect')}
            </Button>
          )}
        </div>

        {pending && !linked ? (
          <Callout
            tone="info"
            action={
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Send className="size-3.5" />}
                  onClick={() => window.open(pending.url, '_blank', 'noopener,noreferrer')}
                >
                  {t('profile.telegram.openBot')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(pending.url)
                      .then(() => toast.show({ title: t('profile.telegram.copied'), tone: 'info' }))
                  }
                >
                  {t('profile.telegram.copyLink')}
                </Button>
              </div>
            }
          >
            {t('profile.telegram.waiting', {
              time: formatDateTime(pending.expiresAt, { locale }),
            })}
          </Callout>
        ) : null}

        {linked ? (
          <p className="text-xs text-fg-secondary">{t('profile.telegram.categoriesHint')}</p>
        ) : null}
      </div>
    </Card>
  )
}
