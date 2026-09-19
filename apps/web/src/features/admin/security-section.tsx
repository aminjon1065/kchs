import type { SecurityPolicy } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import { Button, Card, Checkbox, Field, Input, Skeleton, Switch, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, rolesQuery, securityPolicyQuery } from '~/shared/api/queries.js'
import { AdminModeCard } from './admin-mode.js'

/**
 * Политика безопасности (17-security.md §2): обязательный второй фактор по
 * ролям, гостевые ссылки, простой сессии. Изменения собираются в черновик и
 * сохраняются одной правкой — она попадает в аудит.
 */
export function SecuritySection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const idleId = useId()
  const { data: policy } = useQuery(securityPolicyQuery())
  const { data: roles = [] } = useQuery(rolesQuery())
  const [draft, setDraft] = useState<SecurityPolicy | null>(null)

  const save = useMutation({
    mutationFn: (next: SecurityPolicy) =>
      http.patch<SecurityPolicy>('/admin/security-policy', next),
    onSuccess: (saved) => {
      client.setQueryData(keys.securityPolicy, saved)
      setDraft(null)
      toast.show({ title: t('admin.security.saved'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const value = draft ?? policy
  if (!value) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
      </div>
    )
  }

  const update = (patch: Partial<SecurityPolicy>) => setDraft({ ...value, ...patch })
  const toggleRole = (key: string, on: boolean) =>
    update({
      requireMfaRoles: on
        ? [...value.requireMfaRoles, key]
        : value.requireMfaRoles.filter((item) => item !== key),
    })

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <AdminModeCard />
      <Card title={t('admin.security.mfaTitle')}>
        <p className="text-xs text-fg-secondary">{t('admin.security.mfaHint')}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {roles.map((role) => (
            <Checkbox
              key={role.key}
              id={`mfa-role-${role.key}`}
              checked={value.requireMfaRoles.includes(role.key)}
              onCheckedChange={(next) => toggleRole(role.key, next === true)}
              label={localizedText(role.name, locale)}
            />
          ))}
        </div>
      </Card>

      <Card title={t('admin.security.linksTitle')}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t('admin.security.linksAllowed')}</p>
            <p className="text-xs text-fg-secondary">{t('admin.security.linksHint')}</p>
          </div>
          <Switch
            checked={value.allowShareLinks}
            onCheckedChange={(next) => update({ allowShareLinks: next })}
            aria-label={t('admin.security.linksAllowed')}
          />
        </div>
      </Card>

      <Card title={t('admin.security.idleTitle')}>
        <Field
          label={t('admin.security.idleHours')}
          hint={t('admin.security.idleHint')}
          htmlFor={idleId}
        >
          <Input
            id={idleId}
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            value={value.sessionIdleHours ?? ''}
            onChange={(event) =>
              update({
                sessionIdleHours: event.target.value === '' ? null : Number(event.target.value),
              })
            }
            className="max-w-32"
          />
        </Field>
      </Card>

      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!draft}
          loading={save.isPending}
          onClick={() => draft && save.mutate(draft)}
        >
          {t('common.actions.save')}
        </Button>
        <Button variant="ghost" disabled={!draft} onClick={() => setDraft(null)}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  )
}
