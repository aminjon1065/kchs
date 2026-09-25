import type { AdminUser, PasskeyInfo } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AlertDialog, Badge, Button, Callout, Dialog, DialogContent, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Ключи входа сотрудника в консоли (N45): список перед отзывом и «Отозвать все» —
 * телефон или ключ безопасности потерян, а войти с другого устройства сотрудник не
 * может. Запись аудита пишет сервер.
 */
export function UserPasskeysDialog({
  user,
  onClose,
}: {
  user: Pick<AdminUser, 'id' | 'displayName'>
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const key = ['users', user.id, 'passkeys'] as const
  const { data: items = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await http.get<{ items: PasskeyInfo[] }>(`/users/${user.id}/passkeys`)).items,
  })
  const revoke = useMutation({
    mutationFn: () => http.delete<{ revoked: number }>(`/users/${user.id}/passkeys`),
    onSuccess: (result) => {
      setConfirming(false)
      toast.show({
        title: t('admin.users.passkeysRevoked', { count: result.revoked }),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: ['users'] })
      onClose()
    },
    onError: (error) => {
      setConfirming(false)
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
  })

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent
          title={t('admin.users.passkeysTitle', { name: user.displayName })}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('common.actions.close')}
              </Button>
              <Button
                variant="danger"
                disabled={items.length === 0}
                onClick={() => setConfirming(true)}
              >
                {t('admin.users.passkeysRevoke')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Callout tone="info">{t('admin.users.passkeysHint')}</Callout>
            {isLoading ? null : items.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('profile.passkeys.none')}</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <Fingerprint className="size-4 shrink-0 text-fg-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-fg">{item.name}</p>
                      <p className="text-xs text-fg-secondary">
                        {item.lastUsedAt
                          ? t('profile.passkeys.lastUsed', { at: formatDateTime(item.lastUsedAt) })
                          : t('profile.passkeys.neverUsed', {
                              at: formatDateTime(item.createdAt),
                            })}
                      </p>
                    </div>
                    <Badge size="sm" tone={item.userVerified ? 'success' : 'neutral'}>
                      {item.userVerified
                        ? t('profile.passkeys.verified')
                        : t('profile.passkeys.secondFactorOnly')}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('admin.users.passkeysRevokeTitle', { name: user.displayName })}
        description={t('admin.users.passkeysRevokeHint')}
        confirmLabel={t('admin.users.passkeysRevoke')}
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </>
  )
}
