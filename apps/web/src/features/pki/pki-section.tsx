import type { PkiCertificateRecord, PkiCertificateState, PkiRotationMode } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  KeyValueList,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/shared/i18n.js'
import { CertificateStateBadge } from './certificate-state.js'
import {
  allCertificatesQuery,
  apiErrorMessage,
  issuingCertificateUrl,
  pkiApi,
  pkiKeys,
  pkiStatusQuery,
  rootCertificateUrl,
} from './queries.js'

const ALL = 'all'

/**
 * «УЦ Комитета» в консоли (ADR-0218): создание удостоверяющего центра (один раз),
 * корневой и выпускающий сертификаты для установки доверия, сертификаты сотрудников и
 * печати с отзывом. Создаёт УЦ администратор системы; отзывает — управляющий
 * пользователями.
 */
export function PkiSection({ canInit, canManage }: { canInit: boolean; canManage: boolean }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<PkiCertificateRecord | null>(null)
  const [rotating, setRotating] = useState(false)
  const [mode, setMode] = useState<PkiRotationMode>('planned')
  const [reason, setReason] = useState('')
  const [state, setState] = useState<PkiCertificateState | typeof ALL>('active')
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 300)

  const status = useQuery(pkiStatusQuery())
  const ready = status.data?.initialized ?? false
  const list = useQuery({
    ...allCertificatesQuery({ state: state === ALL ? undefined : state, q: q || undefined }),
    enabled: ready && canManage,
  })

  const init = useMutation({
    mutationFn: pkiApi.init,
    onSuccess: (next) => {
      setCreating(false)
      client.setQueryData(pkiKeys.status, next)
      toast.show({ title: t('admin.pki.created'), tone: 'success' })
    },
    onError: (err) => {
      setCreating(false)
      toast.error(apiErrorMessage(err) ?? t('errors.unknown'))
    },
  })

  // Смена ключа выпускающего (ADR-0224): плановая или после компрометации
  const rotate = useMutation({
    mutationFn: () => pkiApi.rotate({ mode, reason: reason.trim() }),
    onSuccess: (next) => {
      setRotating(false)
      setReason('')
      client.setQueryData(pkiKeys.status, next)
      void client.invalidateQueries({ queryKey: ['pki'] })
      toast.show({ title: t('admin.pki.rotated'), tone: 'success' })
    },
    onError: (err) => toast.error(apiErrorMessage(err) ?? t('errors.unknown')),
  })
  const current = status.data?.issuers.find((issuer) => issuer.current)
  const previous = status.data?.issuers.filter((issuer) => !issuer.current) ?? []
  const expiring = status.data?.expiring ?? []

  const revoke = useMutation({
    mutationFn: (id: string) => pkiApi.revoke(id),
    onSuccess: () => {
      setRevoking(null)
      toast.show({ title: t('admin.pki.revoked'), tone: 'info' })
      void client.invalidateQueries({ queryKey: ['pki'] })
    },
    onError: (err) => {
      setRevoking(null)
      toast.error(apiErrorMessage(err) ?? t('errors.unknown'))
    },
  })

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.pki.hint')}</p>
      <Card
        title={t('admin.pki.authority')}
        action={
          ready ? (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon={<Download className="size-3.5" />}
                onClick={() => window.open(rootCertificateUrl(), '_blank', 'noopener')}
              >
                {t('admin.pki.root')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Download className="size-3.5" />}
                onClick={() =>
                  window.open(issuingCertificateUrl(current?.path), '_blank', 'noopener')
                }
              >
                {t('admin.pki.issuing')}
              </Button>
              {canInit ? (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className="size-3.5" />}
                  onClick={() => setRotating(true)}
                >
                  {t('admin.pki.rotate')}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {status.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : status.data?.initialized ? (
          <div className="flex flex-col gap-3">
            {expiring.length > 0 ? (
              <Callout tone="warning">
                {t('admin.pki.expiring', {
                  list: expiring
                    .map(
                      (item) =>
                        `${t(`admin.pki.kinds.${item.kind}`)} — ${formatDate(item.notAfter)}`,
                    )
                    .join('; '),
                })}
              </Callout>
            ) : null}
            <KeyValueList
              items={[
                { key: 'subject', label: t('admin.pki.subject'), value: status.data.rootSubject },
                {
                  key: 'fingerprint',
                  label: t('admin.pki.fingerprint'),
                  value: (
                    <span className="break-all font-mono text-xs">
                      {status.data.rootFingerprint}
                    </span>
                  ),
                },
                {
                  key: 'root',
                  label: t('admin.pki.rootValid'),
                  value: status.data.rootNotAfter ? formatDate(status.data.rootNotAfter) : '—',
                },
                {
                  key: 'issuing',
                  label: t('admin.pki.issuingValid'),
                  value: status.data.issuingNotAfter
                    ? formatDate(status.data.issuingNotAfter)
                    : '—',
                },
                { key: 'active', label: t('admin.pki.active'), value: status.data.active },
                ...(previous.length > 0
                  ? [
                      {
                        key: 'previous',
                        label: t('admin.pki.previousIssuers'),
                        value: previous
                          .map(
                            (issuer) =>
                              `${issuer.fingerprint.slice(0, 16)} — ${t(
                                issuer.reason === 'compromise'
                                  ? 'admin.pki.modeCompromise'
                                  : 'admin.pki.modePlanned',
                              )}`,
                          )
                          .join('; '),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Callout tone="info">{t('admin.pki.notCreated')}</Callout>
            {canInit ? (
              <Button icon={<ShieldCheck className="size-3.5" />} onClick={() => setCreating(true)}>
                {t('admin.pki.create')}
              </Button>
            ) : null}
          </div>
        )}
      </Card>

      {ready && canManage ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder={t('admin.pki.search')}
              className="max-w-sm"
            />
            <Select value={state} onValueChange={(next) => setState(next as typeof state)}>
              <SelectTrigger aria-label={t('admin.pki.stateFilter')} className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('admin.pki.allStates')}</SelectItem>
                <SelectItem value="active">{t('profile.signingKey.states.active')}</SelectItem>
                <SelectItem value="revoked">{t('profile.signingKey.states.revoked')}</SelectItem>
                <SelectItem value="expired">{t('profile.signingKey.states.expired')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Card padded={false}>
            {list.isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-12 w-full" />
                ))}
              </div>
            ) : (list.data?.items ?? []).length === 0 ? (
              <EmptyState compact icon={<ShieldCheck />} title={t('admin.pki.empty')} />
            ) : (
              <ul className="divide-y divide-line">
                {(list.data?.items ?? []).map((item) => (
                  <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-fg">
                        {item.purpose === 'seal'
                          ? t('admin.pki.seal', { name: item.userName ?? '—' })
                          : (item.userName ?? '—')}
                      </p>
                      <p className="truncate text-xs text-fg-secondary">{item.subject}</p>
                      <p className="text-xs text-fg-muted">
                        {t('admin.pki.issued', {
                          device: item.deviceLabel,
                          from: formatDate(item.issuedAt),
                          to: formatDate(item.expiresAt),
                        })}
                        {item.revokedAt
                          ? ` · ${t('admin.pki.revokedAt', { at: formatDateTime(item.revokedAt) })}`
                          : ''}
                      </p>
                    </div>
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
          </Card>
        </>
      ) : null}

      <AlertDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('admin.pki.createTitle')}
        description={t('admin.pki.createHint')}
        confirmLabel={t('admin.pki.create')}
        loading={init.isPending}
        onConfirm={() => init.mutate()}
      />
      <AlertDialog
        open={rotating}
        onOpenChange={setRotating}
        title={t('admin.pki.rotateTitle')}
        description={t('admin.pki.rotateHint')}
        consequences={
          <div className="flex flex-col gap-3">
            <Field label={t('admin.pki.rotateMode')}>
              <Select value={mode} onValueChange={(value) => setMode(value as PkiRotationMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="planned">{t('admin.pki.modePlanned')}</SelectItem>
                  <SelectItem value="compromise">{t('admin.pki.modeCompromise')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {mode === 'compromise' ? (
              <Callout tone="danger">{t('admin.pki.modeCompromiseHint')}</Callout>
            ) : null}
            <Field label={t('admin.pki.rotateReason')} required>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
              />
            </Field>
          </div>
        }
        confirmLabel={t('admin.pki.rotate')}
        destructive={mode === 'compromise'}
        loading={rotate.isPending}
        onConfirm={() => {
          if (reason.trim().length >= 3) rotate.mutate()
        }}
      />
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('admin.pki.revokeTitle', { name: revoking?.userName ?? '' })}
        description={t('admin.pki.revokeHint')}
        confirmLabel={t('profile.signingKey.revoke')}
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id)
        }}
      />
    </div>
  )
}
