import type { MailPassword, MailStatus } from '@kchs/contracts'
import { Button, Callout, Card, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'

const mailKey = ['me', 'mail'] as const

/**
 * Почта в профиле (ADR-0150): адрес ящика, веб-почта и пароль для почты — отдельный от
 * пароля платформы, показывается один раз. Без почты в установке карточки нет.
 */
export function MailCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [issued, setIssued] = useState<MailPassword | null>(null)
  const { data: status } = useQuery({
    queryKey: mailKey,
    queryFn: () => http.get<MailStatus>('/me/mail'),
  })
  const issue = useMutation({
    mutationFn: () => http.post<MailPassword>('/me/mail/password', {}),
    onSuccess: (result) => {
      setIssued(result)
      void client.invalidateQueries({ queryKey: mailKey })
    },
    onError: () => toast.error(t('errors.unknown')),
  })
  const revoke = useMutation({
    mutationFn: () => http.delete<MailStatus>('/me/mail/password'),
    onSuccess: (next) => {
      setIssued(null)
      client.setQueryData(mailKey, next)
      toast.show({ title: t('profile.mail.revoked'), tone: 'info' })
    },
    onError: () => toast.error(t('errors.unknown')),
  })
  if (!status?.enabled) return null

  return (
    <Card title={t('profile.mail.title')}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="flex items-center gap-2 text-fg">
          <Mail className="size-4 text-fg-muted" aria-hidden />
          <span className="font-medium">{status.address}</span>
        </p>
        <p className="text-fg-secondary">{t('profile.mail.hint')}</p>
        {issued ? (
          <Callout tone="warning">
            <p>{t('profile.mail.passwordOnce')}</p>
            <p className="mt-1">
              <span className="text-fg-secondary">{t('profile.mail.password')}: </span>
              <code className="font-mono text-base text-fg">{issued.password}</code>
            </p>
          </Callout>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            loading={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {status.passwordSet ? t('profile.mail.reissue') : t('profile.mail.issue')}
          </Button>
          {status.passwordSet ? (
            <Button
              variant="ghost"
              size="sm"
              loading={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {t('profile.mail.revoke')}
            </Button>
          ) : null}
          {status.webmailUrl ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => window.open(status.webmailUrl ?? '', '_blank', 'noopener')}
            >
              {t('profile.mail.webmail')}
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
