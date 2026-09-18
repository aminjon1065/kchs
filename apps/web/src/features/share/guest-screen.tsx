import type { FileRecord, ObjectRecord, ShareLinkOpenResult } from '@kchs/contracts'
import { formatDateTime, formatFileSize } from '@kchs/fields'
import { Badge, Button, Callout, Field, ObjectIcon, PasswordInput, Spinner } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, Link2, LogIn } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http, setShareToken } from '~/shared/api/client.js'

/**
 * Гостевой просмотр объекта по ссылке (03-access-model.md §Гостевые ссылки):
 * без входа, только просмотр, с водяным знаком и аудитом открытия.
 */
export function GuestShareScreen({ token }: { token: string }) {
  const t = useT()
  const [password, setPassword] = useState('')
  const [opened, setOpened] = useState<ShareLinkOpenResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const open = useMutation({
    mutationFn: (value?: string) =>
      http.post<ShareLinkOpenResult>(
        `/share/${encodeURIComponent(token)}/open`,
        value ? { password: value } : {},
        { anonymous: true },
      ),
    onSuccess: (result) => {
      setError(null)
      setOpened(result)
      setShareToken(result.accessToken)
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        setError(t('errors.network'))
        return
      }
      if (err.status === 401) setError(t('access.guest.wrongPassword'))
      else if (err.status === 429) setError(t('errors.rate_limited'))
      else setError(t('access.guest.invalid'))
    },
  })

  const openMutate = open.mutate
  useEffect(() => {
    openMutate(undefined)
    return () => setShareToken(null)
  }, [openMutate])

  const objectId = opened?.objectId ?? null

  const object = useQuery({
    queryKey: ['share', token, 'object', objectId],
    enabled: Boolean(objectId),
    queryFn: () => http.get<ObjectRecord>(`/objects/${objectId}`),
  })

  const file = useQuery({
    queryKey: ['share', token, 'file', objectId],
    enabled: Boolean(objectId) && object.data?.type === 'file',
    queryFn: () => http.get<FileRecord>(`/files/${objectId}`),
  })

  const download = useMutation({
    mutationFn: () => http.get<{ url: string; name: string }>(`/files/${objectId}/download`),
    onSuccess: (result) => window.open(result.url, '_blank', 'noopener'),
  })

  const needsPassword = opened?.requiresPassword === true

  return (
    <div className="relative flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      {opened?.watermark ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 select-none overflow-hidden opacity-[0.045]"
        >
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-[-24deg]">
            {Array.from({ length: 14 }, (_, row) => (
              <div
                key={`wm-${row}`}
                className="whitespace-nowrap text-[15px] font-semibold tracking-wide text-fg"
                style={{ lineHeight: '86px' }}
              >
                {`${opened.watermark}  ·  `.repeat(14)}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="relative w-full max-w-[520px]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
            <Link2 className="size-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-fg">{t('access.guest.title')}</h1>
            <p className="mt-0.5 text-sm text-fg-secondary">{t('access.guest.subtitle')}</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 shadow-md">
          {open.isPending && !opened ? (
            <div className="flex items-center justify-center gap-3 py-8">
              <Spinner className="size-5" />
            </div>
          ) : needsPassword ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                open.mutate(password)
              }}
            >
              <h2 className="text-md font-semibold text-fg">{t('access.guest.passwordTitle')}</h2>
              <p className="text-sm text-fg-secondary">{t('access.guest.passwordHint')}</p>
              {error ? <Callout tone="danger">{error}</Callout> : null}
              <Field label={t('access.guest.password')} htmlFor="share-password">
                <PasswordInput
                  id="share-password"
                  autoFocus
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </Field>
              <Button type="submit" variant="primary" block loading={open.isPending}>
                {t('access.guest.open')}
              </Button>
            </form>
          ) : error || object.isError ? (
            <Callout tone="danger">{error ?? t('access.guest.invalid')}</Callout>
          ) : object.data ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                <ObjectIcon type={object.data.type} className="mt-0.5 size-6 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-md font-semibold text-fg">{object.data.title}</h2>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    {t(`objects.types.${object.data.type}`)} ·{' '}
                    {formatDateTime(object.data.updatedAt)}
                  </p>
                </div>
                <Badge tone="neutral">{t('access.guest.onlyView')}</Badge>
              </div>

              {file.data ? (
                <div className="flex items-center justify-between rounded-md border border-line bg-surface-2 px-3 py-2.5">
                  <span className="text-sm text-fg-secondary">
                    {formatFileSize(file.data.size)} · {file.data.mime}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download className="size-4" />}
                    loading={download.isPending}
                    onClick={() => download.mutate()}
                  >
                    {t('common.actions.download')}
                  </Button>
                </div>
              ) : null}

              {opened?.expiresAt ? (
                <p className="text-xs text-fg-muted">
                  {t('access.share.linkExpires')}: {formatDateTime(opened.expiresAt)}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-5" />
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-center">
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
          >
            <LogIn className="size-3.5" aria-hidden />
            {t('access.guest.signIn')}
          </a>
        </div>
      </div>
    </div>
  )
}
