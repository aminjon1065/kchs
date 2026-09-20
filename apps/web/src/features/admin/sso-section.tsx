import type { GroupRoleMapping, SsoSettingsInput, SsoState, SsoTestResult } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  Button,
  Callout,
  Card,
  Field,
  IconButton,
  Input,
  KeyValueList,
  PasswordInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { rolesQuery } from '~/shared/api/queries.js'
import { authProviderKeys, ssoQuery } from './auth-providers.js'

type Draft = SsoSettingsInput

function toDraft(state: SsoState): Draft {
  const { hasClientSecret: _has, updatedAt: _at, redirectUri: _redirect, ...settings } = state
  return settings
}

/**
 * Единый вход через корпоративный IdP (ADR-0098): адрес издателя, клиент,
 * сопоставление claims и групп. Секрет клиента сервер обратно не отдаёт —
 * пустое поле означает «оставить прежний».
 */
export function SsoSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const issuerId = useId()
  const clientIdId = useId()
  const secretId = useId()
  const scopesId = useId()
  const labelId = useId()

  const { data: state } = useQuery(ssoQuery())
  const { data: roles = [] } = useQuery(rolesQuery())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [tested, setTested] = useState<SsoTestResult | null>(null)

  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('errors.unknown'))

  const save = useMutation({
    mutationFn: (next: Draft) => http.put<SsoState>('/admin/sso', next),
    onSuccess: (saved) => {
      client.setQueryData(authProviderKeys.sso, saved)
      setDraft(null)
      toast.show({ title: t('admin.sso.saved'), tone: 'success' })
    },
    onError: failed,
  })

  const test = useMutation({
    mutationFn: () => http.post<SsoTestResult>('/admin/sso/test'),
    onSuccess: setTested,
    onError: failed,
  })

  if (!state) {
    return (
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
        <Skeleton className="h-48" />
        <Skeleton className="h-32" />
      </div>
    )
  }

  const value = draft ?? toDraft(state)
  const update = (patch: Partial<Draft>) => setDraft({ ...value, ...patch })
  const setClaim = (key: keyof Draft['claims'], next: string) =>
    update({ claims: { ...value.claims, [key]: next } })
  const setMapping = (index: number, patch: Partial<GroupRoleMapping>) =>
    update({
      groupMappings: value.groupMappings.map((item, at) =>
        at === index ? { ...item, ...patch } : item,
      ),
    })

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
      <Card title={t('admin.sso.connectionTitle')}>
        <p className="text-xs text-fg-secondary">{t('admin.sso.connectionHint')}</p>
        <div className="mt-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">{t('admin.sso.enabled')}</p>
            <p className="text-xs text-fg-secondary">{t('admin.sso.enabledHint')}</p>
          </div>
          <Switch
            checked={value.enabled}
            onCheckedChange={(next) => update({ enabled: next })}
            aria-label={t('admin.sso.enabled')}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.sso.issuer')} hint={t('admin.sso.issuerHint')} htmlFor={issuerId}>
            <Input
              id={issuerId}
              value={value.issuer}
              onChange={(event) => update({ issuer: event.target.value })}
              placeholder="https://id.example.org/realms/kchs"
            />
          </Field>
          <Field label={t('admin.sso.clientId')} htmlFor={clientIdId}>
            <Input
              id={clientIdId}
              value={value.clientId}
              onChange={(event) => update({ clientId: event.target.value })}
            />
          </Field>
          <Field
            label={t('admin.sso.clientSecret')}
            hint={
              state.hasClientSecret
                ? t('admin.sso.clientSecretKeep')
                : t('admin.sso.clientSecretHint')
            }
            htmlFor={secretId}
          >
            <PasswordInput
              id={secretId}
              value={value.clientSecret ?? ''}
              onChange={(event) => update({ clientSecret: event.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('admin.sso.scopes')} htmlFor={scopesId}>
            <Input
              id={scopesId}
              mono
              value={value.scopes}
              onChange={(event) => update({ scopes: event.target.value })}
            />
          </Field>
          <Field
            label={t('admin.sso.buttonLabel')}
            hint={t('admin.sso.buttonLabelHint')}
            htmlFor={labelId}
          >
            <Input
              id={labelId}
              value={value.buttonLabel}
              onChange={(event) => update({ buttonLabel: event.target.value })}
            />
          </Field>
        </div>

        <div className="mt-4">
          <KeyValueList
            items={[
              { key: 'redirect', label: t('admin.sso.redirectUri'), value: state.redirectUri },
            ]}
          />
          <p className="mt-1 text-xs text-fg-secondary">{t('admin.sso.redirectUriHint')}</p>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <Switch
            checked={value.jitCreate}
            onCheckedChange={(next) => update({ jitCreate: next })}
            label={t('admin.sso.jitCreate')}
          />
          <Switch
            checked={value.endSessionOnLogout}
            onCheckedChange={(next) => update({ endSessionOnLogout: next })}
            label={t('admin.sso.endSession')}
          />
          <Switch
            checked={value.allowInsecureHttp}
            onCheckedChange={(next) => update({ allowInsecureHttp: next })}
            label={t('admin.sso.allowHttp')}
          />
        </div>
      </Card>

      <Card title={t('admin.sso.claimsTitle')}>
        <p className="text-xs text-fg-secondary">{t('admin.sso.claimsHint')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['login', t('admin.directory.fields.login')],
              ['email', t('admin.directory.fields.email')],
              ['lastName', t('admin.directory.fields.lastName')],
              ['firstName', t('admin.directory.fields.firstName')],
              ['middleName', t('admin.directory.fields.middleName')],
              ['displayName', t('admin.directory.fields.displayName')],
              ['groups', t('admin.sso.groupsClaim')],
            ] as Array<[keyof Draft['claims'], string]>
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <Input
                mono
                value={value.claims[key]}
                onChange={(event) => setClaim(key, event.target.value)}
                aria-label={label}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card
        title={t('admin.sso.groupsTitle')}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              update({
                groupMappings: [
                  ...value.groupMappings,
                  { group: '', roleKey: roles[0]?.key ?? 'employee' },
                ],
              })
            }
          >
            {t('admin.directory.addMapping')}
          </Button>
        }
      >
        <p className="text-xs text-fg-secondary">{t('admin.sso.groupsHint')}</p>
        {value.groupMappings.length === 0 ? (
          <p className="mt-3 text-sm text-fg-muted">{t('admin.directory.noMappings')}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {value.groupMappings.map((mapping, index) => (
              // Порядок строк задаёт человек; идентификатора у строки нет
              <li key={`mapping-${index}`} className="flex items-center gap-2">
                <Input
                  mono
                  className="min-w-0 flex-1"
                  value={mapping.group}
                  onChange={(event) => setMapping(index, { group: event.target.value })}
                  placeholder="kchs-gis"
                  aria-label={t('admin.sso.groupName')}
                />
                <Select
                  value={mapping.roleKey}
                  onValueChange={(next) => setMapping(index, { roleKey: next })}
                >
                  <SelectTrigger className="w-48" aria-label={t('admin.directory.role')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.key} value={role.key}>
                        {localizedText(role.name, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <IconButton
                  variant="ghost"
                  size="sm"
                  label={t('common.actions.delete')}
                  onClick={() =>
                    update({ groupMappings: value.groupMappings.filter((_, at) => at !== index) })
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
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
        <Button
          variant="secondary"
          icon={<Plug className="size-3.5" />}
          disabled={Boolean(draft)}
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          {t('admin.sso.testConnection')}
        </Button>
      </div>

      {tested ? (
        <Callout tone={tested.ok ? 'success' : 'danger'} onDismiss={() => setTested(null)}>
          {tested.ok ? (
            <KeyValueList
              items={[
                { key: 'issuer', label: t('admin.sso.issuer'), value: tested.issuer ?? '—' },
                {
                  key: 'authorize',
                  label: t('admin.sso.authorizationEndpoint'),
                  value: tested.authorizationEndpoint ?? '—',
                },
                {
                  key: 'token',
                  label: t('admin.sso.tokenEndpoint'),
                  value: tested.tokenEndpoint ?? '—',
                },
                {
                  key: 'logout',
                  label: t('admin.sso.endSessionEndpoint'),
                  value: tested.endSessionEndpoint ?? '—',
                },
              ]}
            />
          ) : (
            t('admin.sso.testFailed', { error: tested.error ?? '' })
          )}
        </Callout>
      ) : null}
    </div>
  )
}
