import type { PasskeyInfo } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AlertDialog, Badge, Button, Callout, Card, Field, Input, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fingerprint, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { createPasskey, passkeysSupported } from '~/shared/auth/webauthn.js'

const passkeysKey = ['me', 'passkeys'] as const

/**
 * «Мои ключи входа» (ADR-0098): добавление ключа устройства, список и отзыв.
 * Ключ с подтверждением личности входит сам и засчитывается как второй фактор.
 */
export function PasskeysCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PasskeyInfo | null>(null)

  const supported = passkeysSupported()
  const { data: items = [] } = useQuery({
    queryKey: passkeysKey,
    queryFn: () => http.get<{ items: PasskeyInfo[] }>('/me/passkeys'),
    select: (data) => data.items,
    enabled: supported,
  })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: passkeysKey })
    void client.invalidateQueries({ queryKey: keys.me })
  }

  const add = useMutation({
    mutationFn: async () => {
      const options = await http.post<Record<string, unknown>>('/me/passkeys/options')
      const credential = await createPasskey(options)
      return http.post<PasskeyInfo>('/me/passkeys', {
        name: name.trim() || t('profile.passkeys.defaultName'),
        credential,
      })
    },
    onSuccess: () => {
      setName('')
      setError(null)
      toast.show({ title: t('profile.passkeys.added'), tone: 'success' })
      refresh()
    },
    onError: (err) => {
      if (err instanceof ApiError) setError(err.message)
      // Отказ или отмена на устройстве — не ошибка платформы
      else if (err instanceof Error && err.name === 'NotAllowedError') setError(null)
      else setError(t('profile.passkeys.failed'))
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => http.delete(`/me/passkeys/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setRemoving(null)
      toast.show({ title: t('profile.passkeys.removed'), tone: 'info' })
      refresh()
    },
    onError: () => {
      setRemoving(null)
      toast.error(t('errors.unknown'))
    },
  })

  if (!supported) return null

  return (
    <Card
      title={t('profile.passkeys.title')}
      action={
        <Button
          variant="secondary"
          size="sm"
          icon={<Fingerprint className="size-3.5" />}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          {t('profile.passkeys.add')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-secondary">{t('profile.passkeys.hint')}</p>
        {error ? <Callout tone="danger">{error}</Callout> : null}

        <Field
          label={t('profile.passkeys.name')}
          hint={t('profile.passkeys.nameHint')}
          htmlFor={nameId}
        >
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('profile.passkeys.defaultName')}
            className="max-w-72"
          />
        </Field>

        {items.length === 0 ? (
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
                      : t('profile.passkeys.neverUsed', { at: formatDateTime(item.createdAt) })}
                  </p>
                </div>
                {item.userVerified ? (
                  <Badge size="sm" tone="success">
                    {t('profile.passkeys.verified')}
                  </Badge>
                ) : (
                  <Badge size="sm" tone="neutral">
                    {t('profile.passkeys.secondFactorOnly')}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => setRemoving(item)}
                >
                  {t('common.actions.delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('profile.passkeys.removeTitle', { name: removing?.name ?? '' })}
        description={t('profile.passkeys.removeHint')}
        confirmLabel={t('common.actions.delete')}
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </Card>
  )
}
