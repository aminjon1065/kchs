import type { ApiToken } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { AlertDialog, Badge, Button, Card, EmptyState, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { adminApiTokensQuery, keys } from '~/shared/api/queries.js'

const STATUS_TONES: Record<ApiToken['status'], 'success' | 'neutral' | 'warning'> = {
  active: 'success',
  revoked: 'neutral',
  expired: 'warning',
}

/**
 * «Токены API» в администрировании (14-automation-integrations.md §3, ADR-0097):
 * все токены установки, кем выпущены, когда использовались последний раз, и
 * отзыв чужого токена. Выпускаются токены в профиле их владельца.
 */
export function ApiTokensSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data: items = [], isLoading } = useQuery(adminApiTokensQuery())
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  const revoke = useMutation({
    mutationFn: (id: string) => http.delete(`/admin/api-tokens/${id}`),
    onSuccess: () => {
      toast.show({ title: t('admin.apiTokens.revoked'), tone: 'info' })
      setRevoking(null)
      void client.invalidateQueries({ queryKey: keys.adminApiTokens })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-3 p-5">
      <p className="text-sm text-fg-secondary">{t('admin.apiTokens.hint')}</p>
      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<KeyRound />} title={t('admin.apiTokens.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((token) => (
              <li key={token.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{token.name}</span>
                    <Badge tone={STATUS_TONES[token.status]} size="sm" dot>
                      {t(`profile.apiTokens.statuses.${token.status}`)}
                    </Badge>
                    <code className="text-xs text-fg-muted">{token.prefix}…</code>
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {t('admin.apiTokens.owner', { name: token.userName ?? '—' })}
                    {token.createdByName
                      ? ` · ${t('admin.apiTokens.issuedBy', { name: token.createdByName })}`
                      : ''}
                  </p>
                  <p className="mt-1 text-xs text-fg-muted">{token.scopes.join(', ')}</p>
                  <p className="mt-1 text-xs text-fg-muted">
                    {token.lastUsedAt
                      ? t('profile.apiTokens.lastUsed', {
                          date: formatDateTime(token.lastUsedAt, { locale }),
                        })
                      : t('profile.apiTokens.neverUsed')}
                    {token.expiresAt
                      ? ` · ${t('profile.apiTokens.until', {
                          date: formatDateTime(token.expiresAt, { locale }),
                        })}`
                      : ` · ${t('profile.apiTokens.noExpiry')}`}
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
      </Card>
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(next) => (next ? undefined : setRevoking(null))}
        title={t('profile.apiTokens.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('admin.apiTokens.revokeHint')}
        confirmLabel={t('profile.apiTokens.revoke')}
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id)
        }}
      />
    </div>
  )
}
