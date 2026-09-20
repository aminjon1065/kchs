import { API_SCOPES, type ApiToken, type ApiTokenCreated } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, meQuery, myApiTokensQuery } from '~/shared/api/queries.js'

const STATUS_TONES: Record<ApiToken['status'], 'success' | 'neutral' | 'warning'> = {
  active: 'success',
  revoked: 'neutral',
  expired: 'warning',
}

/**
 * «Мои токены» в профиле (14-automation-integrations.md §3, ADR-0097):
 * выпуск токена интеграции с областями доступа и сроком, показ значения один
 * раз и отзыв. Токен действует правами владельца, суженными областями.
 */
export function ApiTokensCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: me } = useQuery(meQuery())
  const { data: items = [], isLoading } = useQuery(myApiTokensQuery())
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<ApiTokenCreated | null>(null)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  const canCreate = me?.capabilities.includes('api_tokens.create') ?? false
  const refresh = () => void client.invalidateQueries({ queryKey: keys.myApiTokens })

  const revoke = useMutation({
    mutationFn: (id: string) => http.delete(`/me/api-tokens/${id}`),
    onSuccess: () => {
      toast.show({ title: t('profile.apiTokens.revoked'), tone: 'info' })
      setRevoking(null)
      refresh()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Card
      title={t('profile.apiTokens.title')}
      action={
        canCreate ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() => setCreating(true)}
          >
            {t('profile.apiTokens.create')}
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-fg-secondary">{t('profile.apiTokens.hint')}</p>
      {!canCreate ? (
        <Callout tone="info" className="mt-3">
          {t('profile.apiTokens.noCapability')}
        </Callout>
      ) : null}
      <div className="mt-3">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<KeyRound />} title={t('profile.apiTokens.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((token) => (
              <li key={token.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{token.name}</span>
                    <Badge tone={STATUS_TONES[token.status]} size="sm" dot>
                      {t(`profile.apiTokens.statuses.${token.status}`)}
                    </Badge>
                    <code className="text-xs text-fg-muted">{token.prefix}…</code>
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">{token.scopes.join(', ')}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {token.expiresAt
                      ? t('profile.apiTokens.until', {
                          date: formatDateTime(token.expiresAt, { locale }),
                        })
                      : t('profile.apiTokens.noExpiry')}
                    {token.lastUsedAt
                      ? ` · ${t('profile.apiTokens.lastUsed', {
                          date: formatDateTime(token.lastUsedAt, { locale }),
                        })}`
                      : ` · ${t('profile.apiTokens.neverUsed')}`}
                  </p>
                </div>
                {token.status === 'active' ? (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(token)}>
                    {t('profile.apiTokens.revoke')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateTokenDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(result) => {
          setCreating(false)
          setIssued(result)
          refresh()
        }}
      />

      <Dialog open={issued !== null} onOpenChange={(next) => (next ? undefined : setIssued(null))}>
        <DialogContent
          title={t('profile.apiTokens.issuedTitle')}
          size="md"
          footer={
            <Button variant="primary" onClick={() => setIssued(null)}>
              {t('common.actions.close')}
            </Button>
          }
        >
          <Callout tone="warning">{t('profile.apiTokens.issuedHint')}</Callout>
          <code className="mt-3 block rounded-md bg-surface-sunken px-3 py-2 text-xs break-all">
            {issued?.secret}
          </code>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(next) => (next ? undefined : setRevoking(null))}
        title={t('profile.apiTokens.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('profile.apiTokens.revokeHint')}
        confirmLabel={t('profile.apiTokens.revoke')}
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id)
        }}
      />
    </Card>
  )
}

function CreateTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (result: ApiTokenCreated) => void
}) {
  const t = useT()
  const formId = useId()
  const [name, setName] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      http.post<ApiTokenCreated>('/me/api-tokens', {
        name,
        scopes,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      }),
    onSuccess: (result) => {
      setName('')
      setScopes([])
      setExpiresAt('')
      setError(null)
      onCreated(result)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const toggle = (scope: string) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('profile.apiTokens.create')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              loading={create.isPending}
              disabled={name.trim().length === 0 || scopes.length === 0}
            >
              {t('profile.apiTokens.issue')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('profile.apiTokens.name')} required>
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
          <Field label={t('profile.apiTokens.expiresAt')} hint={t('profile.apiTokens.expiresHint')}>
            <Input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
          <Field label={t('profile.apiTokens.scopes')} hint={t('profile.apiTokens.scopesHint')}>
            <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
              {API_SCOPES.map((scope) => (
                <Button
                  key={scope}
                  type="button"
                  size="sm"
                  variant={scopes.includes(scope) ? 'primary' : 'secondary'}
                  onClick={() => toggle(scope)}
                >
                  {scope}
                </Button>
              ))}
            </div>
          </Field>
        </form>
      </DialogContent>
    </Dialog>
  )
}
