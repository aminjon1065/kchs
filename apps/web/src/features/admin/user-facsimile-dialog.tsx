import { type AdminUser, FACSIMILE_MAX_BYTES } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Button,
  Callout,
  Dialog,
  DialogContent,
  FileDropzone,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fileBase64 } from '~/shared/files.js'
import { useT } from '~/shared/i18n.js'
import {
  removeUserFacsimile,
  replaceUserFacsimile,
  userFacsimileKey,
  userFacsimileQuery,
} from './facsimile-queries.js'

/**
 * Факсимиле сотрудника в консоли (ADR-0198): есть ли оно, заменить, удалить.
 * Картинку администратор не видит — это подпись человека; каждое действие
 * сервер пишет в журнал аудита.
 */
export function UserFacsimileDialog({
  user,
  onClose,
}: {
  user: Pick<AdminUser, 'id' | 'displayName'>
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const key = userFacsimileKey(user.id)
  const { data, isLoading } = useQuery(userFacsimileQuery(user.id))
  const replace = useMutation({
    mutationFn: async (file: File) => {
      if (file.type && file.type !== 'image/png') throw new Error(t('profile.facsimile.notPng'))
      if (file.size > FACSIMILE_MAX_BYTES) throw new Error(t('profile.facsimile.tooLarge'))
      return replaceUserFacsimile(user.id, await fileBase64(file))
    },
    onSuccess: (result) => {
      setError(null)
      client.setQueryData(key, result)
      toast.show({ title: t('profile.facsimile.saved'), tone: 'success' })
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('errors.unknown')),
  })
  const remove = useMutation({
    mutationFn: () => removeUserFacsimile(user.id),
    onSuccess: (result) => {
      setRemoving(false)
      client.setQueryData(key, result)
      toast.show({ title: t('profile.facsimile.removed'), tone: 'info' })
    },
    onError: (err) => {
      setRemoving(false)
      toast.error(err instanceof Error && err.message ? err.message : t('errors.unknown'))
    },
  })

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent
          title={t('admin.users.facsimileTitle', { name: user.displayName })}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                {t('common.actions.close')}
              </Button>
              {data?.present ? (
                <Button variant="danger" onClick={() => setRemoving(true)}>
                  {t('profile.facsimile.remove')}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Callout tone="info">{t('admin.users.facsimileHint')}</Callout>
            {error ? <Callout tone="danger">{error}</Callout> : null}
            {isLoading ? (
              <Skeleton className="h-6 w-48" />
            ) : data?.present ? (
              <p className="text-sm text-fg">
                {t('admin.users.facsimilePresent', {
                  width: data.width ?? 0,
                  height: data.height ?? 0,
                  at: data.updatedAt ? formatDateTime(data.updatedAt) : '—',
                  name: data.updatedBy?.displayName ?? '—',
                })}
              </p>
            ) : (
              <p className="text-sm text-fg-muted">{t('admin.users.facsimileAbsent')}</p>
            )}
            <FileDropzone
              compact
              multiple={false}
              accept="image/png"
              disabled={replace.isPending}
              label={data?.present ? t('profile.facsimile.replace') : t('profile.facsimile.upload')}
              hint={t('profile.facsimile.limits')}
              onFiles={(files) => {
                const file = files[0]
                if (file) replace.mutate(file)
              }}
            />
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={removing}
        onOpenChange={(open) => (open ? undefined : setRemoving(false))}
        title={t('profile.facsimile.removeTitle')}
        description={t('admin.users.facsimileRemoveHint', { name: user.displayName })}
        confirmLabel={t('profile.facsimile.remove')}
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  )
}
