import type { AdminUser } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { Avatar, Badge, Button, Dialog, DialogContent, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserCheck } from 'lucide-react'
import { useState } from 'react'
import { CreateDelegationDialog } from '~/entities/people/delegation-dialog.js'
import { ApiError } from '~/shared/api/errors.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { adminApi } from './queries.js'

/**
 * Замещения сотрудника в консоли (ADR-0229): кадры назначают заместителя тому, кто
 * заболел и сам в систему не войдёт, видят действующие и запланированные замещения и
 * завершают их. Запись аудита пишет сервер.
 */
export function UserDelegationsDialog({
  user,
  onClose,
}: {
  user: Pick<AdminUser, 'id' | 'displayName'>
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const locale = useLocale()
  const client = useQueryClient()
  const [creating, setCreating] = useState(false)
  const key = ['users', user.id, 'delegations'] as const
  const { data: items = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => (await adminApi.getUsersDelegations(user.id)).items,
  })
  const refresh = () => void client.invalidateQueries({ queryKey: key })
  const stop = useMutation({
    mutationFn: (id: string) => adminApi.removeDelegation(id),
    onSuccess: () => {
      toast.show({ title: t('admin.delegation.stopped'), tone: 'info' })
      refresh()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent
          title={t('admin.delegation.ofUser', { name: user.displayName })}
          size="md"
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('common.actions.done')}
              </Button>
              <Button
                variant="primary"
                icon={<UserCheck className="size-4" />}
                onClick={() => setCreating(true)}
              >
                {t('admin.delegation.create')}
              </Button>
            </>
          }
        >
          {!isLoading && items.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('admin.delegation.none')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <Avatar name={item.toUser.displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {item.fromUser.displayName} → {item.toUser.displayName}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {t(`admin.delegation.scopes.${item.scope}`)} ·{' '}
                      {formatDate(item.startsAt, { locale })} —{' '}
                      {formatDate(item.endsAt, { locale })}
                    </span>
                  </span>
                  <Badge tone={item.upcoming ? 'neutral' : 'warning'} size="sm">
                    {t(item.upcoming ? 'admin.delegation.planned' : 'admin.delegation.active')}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={stop.isPending && stop.variables === item.id}
                    onClick={() => stop.mutate(item.id)}
                  >
                    {t(item.upcoming ? 'admin.delegation.cancel' : 'admin.delegation.stop')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <CreateDelegationDialog
        open={creating}
        onOpenChange={setCreating}
        excludeUserId={user.id}
        submit={(body) => adminApi.postUsersDelegations(user.id, body)}
        onCreated={(name) => {
          toast.show({ title: t('admin.delegation.createdFor', { name }), tone: 'success' })
          refresh()
        }}
      />
    </>
  )
}
