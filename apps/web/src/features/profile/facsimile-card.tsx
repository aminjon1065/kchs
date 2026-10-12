import { FACSIMILE_MAX_BYTES } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AlertDialog, Button, Callout, Card, FileDropzone, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { fileBase64 } from '~/shared/files.js'
import { useT } from '~/shared/i18n.js'
import {
  facsimileKey,
  facsimileQuery,
  removeFacsimile,
  saveFacsimile,
} from './facsimile-queries.js'

/**
 * «Факсимиле» в профиле (ADR-0198): заранее загруженное изображение подписи —
 * его ставит подписанный экземпляр у фамилии. Картинку видит только сам сотрудник.
 */
export function FacsimileCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const { data, isLoading } = useQuery(facsimileQuery())

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.type && file.type !== 'image/png') throw new Error(t('profile.facsimile.notPng'))
      if (file.size > FACSIMILE_MAX_BYTES) throw new Error(t('profile.facsimile.tooLarge'))
      return saveFacsimile(await fileBase64(file))
    },
    onSuccess: (result) => {
      setError(null)
      client.setQueryData(facsimileKey, result)
      toast.show({ title: t('profile.facsimile.saved'), tone: 'success' })
    },
    onError: (err) => setError(err instanceof Error ? err.message : t('errors.unknown')),
  })

  const remove = useMutation({
    mutationFn: removeFacsimile,
    onSuccess: (result) => {
      setRemoving(false)
      client.setQueryData(facsimileKey, result)
      toast.show({ title: t('profile.facsimile.removed'), tone: 'info' })
    },
    onError: (err) => {
      setRemoving(false)
      toast.error(err instanceof Error && err.message ? err.message : t('errors.unknown'))
    },
  })

  return (
    <Card
      title={t('profile.facsimile.title')}
      action={
        data?.present ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setRemoving(true)}
          >
            {t('profile.facsimile.remove')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-secondary">{t('profile.facsimile.hint')}</p>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {isLoading ? (
          <Skeleton className="h-20 w-60" />
        ) : data?.dataUri ? (
          <figure className="flex flex-col gap-1">
            <div className="flex h-24 w-72 items-center justify-center rounded-md border border-line bg-surface p-2">
              <img
                src={data.dataUri}
                alt={t('profile.facsimile.preview')}
                className="max-h-full max-w-full object-contain"
              />
            </div>
            {data.updatedAt ? (
              <figcaption className="text-2xs text-fg-muted">
                {t('profile.facsimile.updated', {
                  at: formatDateTime(data.updatedAt),
                  name: data.updatedBy?.displayName ?? '—',
                })}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <p className="text-sm text-fg-muted">{t('profile.facsimile.none')}</p>
        )}
        <FileDropzone
          compact
          multiple={false}
          accept="image/png"
          disabled={upload.isPending}
          label={data?.present ? t('profile.facsimile.replace') : t('profile.facsimile.upload')}
          hint={t('profile.facsimile.limits')}
          onFiles={(files) => {
            const file = files[0]
            if (file) upload.mutate(file)
          }}
        />
      </div>
      {removing ? (
        <AlertDialog
          open
          onOpenChange={(open) => (open ? undefined : setRemoving(false))}
          title={t('profile.facsimile.removeTitle')}
          description={t('profile.facsimile.removeHint')}
          confirmLabel={t('profile.facsimile.remove')}
          destructive
          loading={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </Card>
  )
}
