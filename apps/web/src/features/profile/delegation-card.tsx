import type { ActiveDelegation } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { Avatar, Badge, Button, Card, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCheck } from 'lucide-react'
import { useState } from 'react'
import { CreateDelegationDialog } from '~/entities/people/delegation-dialog.js'
import { delegationsQuery, keys, meQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { profileApi } from './queries.js'

/**
 * Замещение (P0-E04 S03, 03-access-model.md §Делегирование): назначить
 * заместителя на период и область, завершить досрочно. Заместитель видит
 * баннер «Вы замещаете» и действует «от имени» — с двойной записью в аудите.
 */
export function DelegationCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useLocale()
  const { data: me } = useQuery(meQuery())
  const { data: delegations = [] } = useQuery(delegationsQuery())
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.delegations })
    void client.invalidateQueries({ queryKey: keys.me })
  }

  const stop = useMutation({
    mutationFn: (id: string) => profileApi.removeMeDelegations(id),
    onSuccess: () => {
      toast.show({ title: t('admin.delegation.stopped'), tone: 'info' })
      refresh()
    },
    onError: () => toast.error(t('errors.forbidden')),
  })

  const period = (item: ActiveDelegation) =>
    `${formatDate(item.startsAt, { locale })} — ${formatDate(item.endsAt, { locale })}`

  return (
    <Card
      title={t('admin.delegation.title')}
      padded={false}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<UserCheck className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('admin.delegation.create')}
        </Button>
      }
    >
      {delegations.length === 0 ? (
        <p className="px-4 py-3 text-sm text-fg-muted">{t('admin.delegation.none')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {delegations.map((item) => {
            const mine = item.fromUser.id === me?.user.id
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Avatar
                  name={mine ? item.toUser.displayName : item.fromUser.displayName}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {item.fromUser.displayName} → {item.toUser.displayName}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {t(`admin.delegation.scopes.${item.scope}`)} · {period(item)}
                  </span>
                </span>
                {/* Запланированное видно заранее и отменяется (ADR-0229) */}
                <Badge tone={item.upcoming ? 'neutral' : 'warning'} size="sm">
                  {t(item.upcoming ? 'admin.delegation.planned' : 'admin.delegation.active')}
                </Badge>
                {mine ? (
                  <Button variant="ghost" size="sm" onClick={() => stop.mutate(item.id)}>
                    {t(item.upcoming ? 'admin.delegation.cancel' : 'admin.delegation.stop')}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <CreateDelegationDialog
        open={creating}
        onOpenChange={setCreating}
        excludeUserId={me?.user.id}
        submit={(body) => profileApi.postMeDelegations(body)}
        onCreated={(name) => {
          toast.show({ title: t('admin.delegation.created', { name }), tone: 'success' })
          refresh()
        }}
      />
    </Card>
  )
}
