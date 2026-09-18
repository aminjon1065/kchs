import type { SessionInfo } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import { LOCALE_NAMES, LOCALES, type Locale } from '@kchs/i18n'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Field,
  PasswordInput,
  SegmentedControl,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LogOut, Monitor, Moon, Smartphone, Sun } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'
import { delegationsQuery, keys, meQuery } from '~/shared/api/queries.js'
import { MfaCard } from './mfa-card.js'

export function ProfileScreen() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const appearance = useAppearance()

  const { data: me, isLoading } = useQuery(meQuery())
  const { data: delegations = [] } = useQuery(delegationsQuery())
  const { data: sessions } = useQuery({
    queryKey: ['me', 'sessions'],
    queryFn: () => http.get<{ items: SessionInfo[] }>('/me/sessions'),
    select: (data) => data.items,
  })

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)

  const changePassword = useMutation({
    mutationFn: () =>
      http.post('/me/password', { currentPassword, newPassword, revokeOtherSessions: true }),
    onSuccess: () => {
      setCurrentPassword('')
      setNewPassword('')
      setPasswordError(null)
      toast.show({ title: t('auth.password.changed'), tone: 'success' })
    },
    onError: (error) =>
      setPasswordError(
        error instanceof ApiError
          ? (Object.values(error.fieldErrors())[0] ?? error.message)
          : t('errors.unknown'),
      ),
  })

  const updateProfile = useMutation({
    mutationFn: (patch: Record<string, unknown>) => http.patch('/me', patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.me }),
  })

  const signOut = useMutation({
    mutationFn: () => http.post('/auth/logout'),
    onSuccess: () => {
      setCsrfToken(null)
      window.location.reload()
    },
  })

  const revokeAll = useMutation({
    mutationFn: () => http.post('/me/sessions/revoke', { all: true }),
    onSuccess: () => {
      toast.show({ title: t('auth.session.othersRevoked'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['me', 'sessions'] })
    },
  })

  if (isLoading || !me) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full max-w-xl" />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-6 py-6">
        <header className="flex items-center gap-4">
          <Avatar name={me.user.displayName} src={me.user.avatarUrl} size="xl" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-fg">{me.user.displayName}</h1>
            <p className="text-sm text-fg-secondary">
              {[me.positions[0]?.name, me.units.find((u) => u.isPrimary)?.name]
                .filter(Boolean)
                .join(' · ') || me.user.login}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {me.roles.map((role) => (
                <Badge key={role} size="sm" tone="accent">
                  {role}
                </Badge>
              ))}
            </div>
          </div>
          <Button
            className="ml-auto"
            variant="secondary"
            icon={<LogOut className="size-4" />}
            onClick={() => signOut.mutate()}
          >
            {t('auth.signOut')}
          </Button>
        </header>

        <Card title={t('profile.appearance')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('common.labels.theme')}>
              <SegmentedControl
                aria-label={t('common.labels.theme')}
                value={appearance.theme}
                onValueChange={(next) => appearance.setTheme(next as 'light' | 'dark' | 'system')}
                options={[
                  {
                    value: 'light',
                    label: '',
                    icon: <Sun className="size-3.5" />,
                    title: t('common.theme.light'),
                  },
                  {
                    value: 'dark',
                    label: '',
                    icon: <Moon className="size-3.5" />,
                    title: t('common.theme.dark'),
                  },
                  {
                    value: 'system',
                    label: '',
                    icon: <Monitor className="size-3.5" />,
                    title: t('common.theme.system'),
                  },
                ]}
              />
            </Field>
            <Field label={t('common.labels.density')}>
              <SegmentedControl
                aria-label={t('common.labels.density')}
                value={appearance.density}
                onValueChange={(next) => appearance.setDensity(next as 'comfortable' | 'compact')}
                options={[
                  { value: 'comfortable', label: t('common.density.comfortable') },
                  { value: 'compact', label: t('common.density.compact') },
                ]}
              />
            </Field>
            <Field label={t('common.labels.language')}>
              <SegmentedControl
                aria-label={t('common.labels.language')}
                value={locale}
                onValueChange={(next) => {
                  appearance.setLocale(next as Locale)
                  updateProfile.mutate({ locale: next })
                }}
                options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value].short }))}
              />
            </Field>
          </div>
        </Card>

        <MfaCard enabled={me.mfaEnabled} />

        <Card title={t('auth.password.title')}>
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault()
              changePassword.mutate()
            }}
          >
            <Field label={t('auth.password.current')} htmlFor="current-password">
              <PasswordInput
                id="current-password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field
              label={t('auth.reset.newPassword')}
              htmlFor="new-password"
              error={passwordError}
              hint={t('auth.password.minLengthHint')}
            >
              <PasswordInput
                id="new-password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                variant="secondary"
                disabled={!currentPassword || newPassword.length < 12}
                loading={changePassword.isPending}
              >
                {t('auth.reset.confirm')}
              </Button>
            </div>
          </form>
        </Card>

        <Card
          title={t('auth.session.devices')}
          action={
            <Button variant="ghost" size="sm" onClick={() => revokeAll.mutate()}>
              {t('auth.session.revokeAll')}
            </Button>
          }
          padded={false}
        >
          <ul className="divide-y divide-line">
            {(sessions ?? []).map((session) => (
              <li key={session.id} className="flex items-center gap-3 px-4 py-2.5">
                <Smartphone className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    {session.deviceName ?? t('auth.session.unknownDevice')}
                  </span>
                  <span className="block truncate text-xs text-fg-muted">
                    {session.ip ?? '—'} · {formatRelativeTime(session.lastActiveAt, { locale })}
                  </span>
                </span>
                {session.current ? (
                  <Badge tone="success" size="sm">
                    {t('auth.session.current')}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        {delegations.length > 0 ? (
          <Card title={t('admin.delegation.title')} padded={false}>
            <ul className="divide-y divide-line">
              {delegations.map((delegation) => (
                <li key={delegation.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Avatar name={delegation.toUser.displayName} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      {delegation.fromUser.displayName} → {delegation.toUser.displayName}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {t(`admin.delegation.scopes.${delegation.scope}`)}
                    </span>
                  </span>
                  <Badge tone="warning" size="sm">
                    {t('admin.delegation.active')}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
