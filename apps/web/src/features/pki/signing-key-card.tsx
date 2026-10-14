import type { PkiCertificateRecord, PkiPurpose } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  SegmentedControl,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, KeyRound, Stamp } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { CertificateStateBadge } from './certificate-state.js'
import {
  createDeviceKey,
  DeviceKeyUnsupportedError,
  deviceKeys,
  forgetDeviceKey,
} from './device-keys.js'
import {
  apiErrorMessage,
  myCertificatesQuery,
  pkiApi,
  pkiKeys,
  pkiStatusQuery,
  rootCertificateUrl,
} from './queries.js'

/**
 * «Ключ подписи» в профиле (ADR-0218): ключ создаётся в браузере этого устройства и не
 * покидает его, УЦ Комитета выпускает на него сертификат. Им подписывают документы КЭП;
 * у кого есть право печати — может выпустить и сертификат печати организации.
 */
export function SigningKeyCard({
  userId,
  canSeal,
  mfaEnabled,
}: {
  userId: string
  canSeal: boolean
  mfaEnabled: boolean
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const labelId = useId()
  const codeId = useId()
  const [label, setLabel] = useState('')
  const [code, setCode] = useState('')
  const [purpose, setPurpose] = useState<PkiPurpose>('person')
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<PkiCertificateRecord | null>(null)

  const status = useQuery(pkiStatusQuery())
  const mine = useQuery(myCertificatesQuery())
  const local = useQuery({
    queryKey: [...pkiKeys.mine, 'device', userId],
    queryFn: () => deviceKeys(userId),
  })
  const onDevice = new Set((local.data ?? []).map((item) => item.id))

  const refresh = () => void client.invalidateQueries({ queryKey: pkiKeys.mine })

  const create = useMutation({
    mutationFn: () =>
      createDeviceKey({
        userId,
        purpose,
        label: label.trim() || t('profile.signingKey.defaultLabel'),
        code: code.trim(),
      }),
    onSuccess: () => {
      setCode('')
      setLabel('')
      setError(null)
      toast.show({ title: t('profile.signingKey.created'), tone: 'success' })
      refresh()
    },
    onError: (err) =>
      setError(
        err instanceof DeviceKeyUnsupportedError
          ? t('profile.signingKey.unsupported')
          : (apiErrorMessage(err) ?? t('profile.signingKey.failed')),
      ),
  })

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const record = await pkiApi.revokeMine(id)
      await forgetDeviceKey(id)
      return record
    },
    onSuccess: () => {
      setRevoking(null)
      toast.show({ title: t('profile.signingKey.revoked'), tone: 'info' })
      refresh()
    },
    onError: () => {
      setRevoking(null)
      toast.error(t('errors.unknown'))
    },
  })

  const items = mine.data?.items ?? []
  const ready = status.data?.initialized ?? false

  return (
    <Card
      title={t('profile.signingKey.title')}
      action={
        ready ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<Download className="size-3.5" />}
            onClick={() => window.open(rootCertificateUrl(), '_blank', 'noopener')}
          >
            {t('profile.signingKey.root')}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-secondary">{t('profile.signingKey.hint')}</p>
        {status.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !ready ? (
          <Callout tone="info">{t('profile.signingKey.noAuthority')}</Callout>
        ) : (
          <>
            {status.data?.rootFingerprint ? (
              <p className="text-2xs text-fg-muted">
                {t('profile.signingKey.fingerprint')}{' '}
                <span className="break-all font-mono">{status.data.rootFingerprint}</span>
              </p>
            ) : null}
            {error ? <Callout tone="danger">{error}</Callout> : null}
            {!mfaEnabled ? (
              <Callout tone="warning">{t('profile.signingKey.needMfa')}</Callout>
            ) : (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  create.mutate()
                }}
              >
                {canSeal ? (
                  <SegmentedControl<PkiPurpose>
                    value={purpose}
                    onValueChange={setPurpose}
                    aria-label={t('profile.signingKey.purpose')}
                    className="self-start"
                    options={[
                      { value: 'person', label: t('profile.signingKey.purposes.person') },
                      { value: 'seal', label: t('profile.signingKey.purposes.seal') },
                    ]}
                  />
                ) : null}
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('profile.signingKey.label')} htmlFor={labelId}>
                    <Input
                      id={labelId}
                      value={label}
                      maxLength={120}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder={t('profile.signingKey.defaultLabel')}
                      className="w-64"
                    />
                  </Field>
                  <Field label={t('profile.signingKey.code')} htmlFor={codeId}>
                    <Input
                      id={codeId}
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      className="w-32 font-mono"
                    />
                  </Field>
                  <Button
                    type="submit"
                    icon={<KeyRound className="size-3.5" />}
                    disabled={!/^\d{6}$/.test(code.trim())}
                    loading={create.isPending}
                  >
                    {purpose === 'seal'
                      ? t('profile.signingKey.createSeal')
                      : t('profile.signingKey.create')}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}

        {items.length === 0 ? (
          ready ? (
            <p className="text-sm text-fg-muted">{t('profile.signingKey.none')}</p>
          ) : null
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                {item.purpose === 'seal' ? (
                  <Stamp className="size-4 shrink-0 text-fg-muted" aria-hidden />
                ) : (
                  <KeyRound className="size-4 shrink-0 text-fg-muted" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-fg">
                    {item.deviceLabel}
                    {item.purpose === 'seal' ? ` · ${t('profile.signingKey.purposes.seal')}` : ''}
                  </p>
                  <p className="text-xs text-fg-secondary">
                    {t('profile.signingKey.validity', {
                      from: formatDate(item.issuedAt),
                      to: formatDate(item.expiresAt),
                    })}
                  </p>
                </div>
                {onDevice.has(item.id) ? (
                  <Badge size="sm" tone="accent">
                    {t('profile.signingKey.thisDevice')}
                  </Badge>
                ) : null}
                <CertificateStateBadge state={item.state} />
                {item.state === 'active' ? (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(item)}>
                    {t('profile.signingKey.revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('profile.signingKey.revokeTitle', { name: revoking?.deviceLabel ?? '' })}
        description={t('profile.signingKey.revokeHint')}
        confirmLabel={t('profile.signingKey.revoke')}
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id)
        }}
      />
    </Card>
  )
}
