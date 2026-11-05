import { LOCALE_NAMES, LOCALES, type Locale } from '@kchs/i18n'
import { Button, Callout, Field, Input, PasswordInput, SegmentedControl } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Building2, Fingerprint, KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useBranding } from '~/shared/api/branding.js'
import { ApiError } from '~/shared/api/errors.js'
import { setCsrfToken } from '~/shared/api/session.js'
import { useAppearance, useLocale } from '~/shared/appearance.js'
import { passkeysSupported, requestPasskey } from '~/shared/auth/webauthn.js'
import { BrandMark } from '~/shared/brand-mark.js'
import { useT } from '~/shared/i18n.js'
import { capitalCoordinates, LoginMap } from './login-map.js'
import { authApi, methodsQuery } from './queries.js'

type Step = 'credentials' | 'mfa' | 'reset'

/** Второй фактор, который принял сервер для этого вызова входа. */
type Factor = 'totp' | 'recovery_code' | 'passkey'

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const t = useT()
  // Название, логотип и приписка организации — до входа (15-admin-operations.md §1)
  const branding = useBranding()
  const locale = useLocale()
  const setLocale = useAppearance((s) => s.setLocale)

  // Провайдер вернул отказ (`?sso=denied`, ADR-0098) — говорим об этом сразу
  const deniedBySso =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('sso') === 'denied'

  const [step, setStep] = useState<Step>('credentials')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(deniedBySso ? t('auth.signIn.ssoDenied') : null)
  const [resetSent, setResetSent] = useState(false)
  const [factors, setFactors] = useState<Factor[]>(['totp'])

  // Способы входа установки: кнопка IdP и вход по ключу показываются,
  // только если они настроены
  const { data: methods } = useQuery({ ...methodsQuery(), staleTime: 60_000, retry: false })
  const canUseKeys = passkeysSupported() && (methods?.passkeys ?? false)

  // Лимит частоты — понятным текстом со временем ожидания, а не ответом сервера
  const failure = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 429) {
      return t('auth.signIn.tooManyAttempts', { seconds: err.problem.retryAfter ?? 60 })
    }
    return err instanceof ApiError ? err.message : fallback
  }

  const signIn = useMutation({
    mutationFn: () => authApi.login({ login, password, rememberDevice: false }),
    onSuccess: (result) => {
      setError(null)
      if (result.status === 'mfa_required') {
        setFactors(result.methods?.length ? result.methods : ['totp'])
        setStep('mfa')
        return
      }
      if (result.csrfToken) setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => setError(failure(err, t('errors.unknown'))),
  })

  const verifyMfa = useMutation({
    mutationFn: () => authApi.postMfaVerify({ challengeId: '', code, trustDevice: false }),
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => setError(failure(err, t('auth.mfa.invalid'))),
  })

  /** Вход через корпоративный IdP: браузер уходит на страницу провайдера. */
  const startSso = useMutation({
    mutationFn: () => authApi.postSsoStart(),
    onSuccess: (result) => {
      window.location.assign(result.url)
    },
    onError: (err) => setError(failure(err, t('errors.unknown'))),
  })

  /** Самостоятельный вход по ключу: вызов сервера → подпись устройства → сессия. */
  const signInWithKey = useMutation({
    mutationFn: async () => {
      const options = await authApi.postPasskeyOptions()
      const credential = await requestPasskey(options)
      return authApi.postPasskeyVerify({ credential })
    },
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => {
      // Отмена на устройстве — не ошибка: человек просто передумал
      if (err instanceof Error && err.name === 'NotAllowedError') return
      setError(failure(err, t('auth.passkey.failed')))
    },
  })

  /** Подтверждение второго фактора ключом поверх входа по паролю. */
  const verifyWithKey = useMutation({
    mutationFn: async () => {
      const options = await authApi.postMfaPasskeyOptions()
      const credential = await requestPasskey(options)
      return authApi.postMfaPasskeyVerify({ credential })
    },
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => {
      if (err instanceof Error && err.name === 'NotAllowedError') return
      setError(failure(err, t('auth.passkey.failed')))
    },
  })

  const requestReset = useMutation({
    mutationFn: () => authApi.postPasswordReset({ login }),
    onSuccess: () => {
      setError(null)
      setResetSent(true)
    },
    onError: (err) => setError(failure(err, t('errors.unknown'))),
  })

  const coordinates = capitalCoordinates(locale)
  const mark = <BrandMark />

  return (
    <div className="flex min-h-full bg-surface">
      {/* Тёмная панель с картой (ADR-0230): на узком окне её нет — форма на всю ширину */}
      <aside className="relative hidden min-w-0 flex-1 flex-col justify-between gap-10 overflow-hidden bg-rail px-14 py-12 lg:flex">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {mark}
            <span className="text-md font-semibold text-rail-fg-active">{t('common.appName')}</span>
          </div>
          {coordinates ? (
            <span className="font-mono text-xs tracking-wider text-rail-fg">
              {t('auth.signIn.capitalAt', coordinates)}
            </span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 items-center">
          <LoginMap locale={locale} />
        </div>

        <div className="flex flex-col gap-6">
          {/* Название и приписка организации — из брендирования (Q13) */}
          <h2 className="max-w-xl text-2xl text-rail-fg-active">
            {branding?.name || t('auth.signIn.subtitle')}
          </h2>
          <p className="border-t border-rail-fg/20 pt-4 text-xs text-rail-fg">
            {t('auth.signIn.mapAttribution')}
          </p>
        </div>
      </aside>

      <main className="flex w-full flex-col px-6 py-10 lg:w-140 lg:flex-none lg:px-16">
        <div className="flex justify-end">
          <SegmentedControl
            size="sm"
            aria-label={t('common.labels.language')}
            value={locale}
            onValueChange={(next) => setLocale(next as Locale)}
            options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value].short }))}
          />
        </div>

        <div className="mx-auto flex w-full max-w-100 flex-1 flex-col justify-center gap-8 py-10">
          {/* На узком окне панели нет — знак и организация над формой */}
          <div className="flex items-center gap-3 lg:hidden">
            {mark}
            <div className="min-w-0">
              <p className="text-md font-semibold text-fg">{t('common.appName')}</p>
              <p className="truncate text-xs text-fg-secondary">
                {branding?.name || t('auth.signIn.subtitle')}
              </p>
            </div>
          </div>

          <div>
            {step === 'credentials' ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  signIn.mutate()
                }}
              >
                <div className="flex flex-col gap-2">
                  <h1 className="text-3xl text-fg">{t('auth.signIn.title')}</h1>
                  <p className="text-md text-fg-secondary">{t('auth.signIn.subtitle')}</p>
                </div>

                {error ? <Callout tone="danger">{error}</Callout> : null}

                <Field label={t('auth.signIn.login')} htmlFor="login">
                  <Input
                    id="login"
                    name="username"
                    autoComplete="username"
                    autoFocus
                    value={login}
                    onChange={(event) => setLogin(event.target.value)}
                    placeholder="ivanov"
                    required
                  />
                </Field>

                <Field label={t('auth.signIn.password')} htmlFor="password">
                  <PasswordInput
                    id="password"
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </Field>

                <Button
                  type="submit"
                  variant="primary"
                  block
                  loading={signIn.isPending}
                  icon={<KeyRound className="size-4" />}
                >
                  {t('auth.signIn.submit')}
                </Button>

                {methods?.sso.enabled || canUseKeys ? (
                  <div className="flex items-center gap-3">
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-xs text-fg-muted">{t('auth.signIn.orWith')}</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                ) : null}

                {methods?.sso.enabled ? (
                  <Button
                    type="button"
                    variant="secondary"
                    block
                    loading={startSso.isPending}
                    icon={<Building2 className="size-4" />}
                    onClick={() => startSso.mutate()}
                  >
                    {methods.sso.buttonLabel || t('auth.signIn.sso')}
                  </Button>
                ) : null}

                {canUseKeys ? (
                  <Button
                    type="button"
                    variant="secondary"
                    block
                    loading={signInWithKey.isPending}
                    icon={<Fingerprint className="size-4" />}
                    onClick={() => signInWithKey.mutate()}
                  >
                    {t('auth.passkey.signIn')}
                  </Button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setStep('reset')
                    setError(null)
                  }}
                  className="text-center text-xs text-accent hover:underline"
                >
                  {t('auth.signIn.forgot')}
                </button>
              </form>
            ) : step === 'mfa' ? (
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  verifyMfa.mutate()
                }}
              >
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="mt-1.5 size-6 shrink-0 text-accent" aria-hidden />
                  <div>
                    <h1 className="text-2xl text-fg">{t('auth.mfa.title')}</h1>
                    <p className="mt-1 text-sm text-fg-secondary">{t('auth.mfa.subtitle')}</p>
                  </div>
                </div>

                {error ? <Callout tone="danger">{error}</Callout> : null}

                {factors.includes('totp') ? (
                  <>
                    <Field label={t('auth.mfa.code')} htmlFor="code">
                      <Input
                        id="code"
                        autoFocus
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={24}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        className="text-center text-lg tracking-[0.3em]"
                        mono
                      />
                    </Field>

                    <Button type="submit" variant="primary" block loading={verifyMfa.isPending}>
                      {t('auth.mfa.submit')}
                    </Button>
                  </>
                ) : null}

                {factors.includes('passkey') ? (
                  <Button
                    type="button"
                    variant={factors.includes('totp') ? 'secondary' : 'primary'}
                    block
                    loading={verifyWithKey.isPending}
                    icon={<Fingerprint className="size-4" />}
                    onClick={() => verifyWithKey.mutate()}
                  >
                    {t('auth.passkey.confirm')}
                  </Button>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setStep('credentials')
                    setCode('')
                    setError(null)
                  }}
                  className="text-center text-xs text-fg-muted hover:text-fg"
                >
                  {t('common.actions.back')}
                </button>
              </form>
            ) : (
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  requestReset.mutate()
                }}
              >
                <h1 className="text-2xl text-fg">{t('auth.reset.title')}</h1>
                {error ? <Callout tone="danger">{error}</Callout> : null}
                {resetSent ? (
                  <Callout tone="success">{t('auth.reset.sent')}</Callout>
                ) : (
                  <>
                    <p className="text-sm text-fg-secondary">{t('auth.reset.hint')}</p>
                    <Field label={t('auth.signIn.login')} htmlFor="reset-login">
                      <Input
                        id="reset-login"
                        autoFocus
                        value={login}
                        onChange={(event) => setLogin(event.target.value)}
                        required
                      />
                    </Field>
                    <Button type="submit" variant="primary" block loading={requestReset.isPending}>
                      {t('auth.reset.submit')}
                    </Button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStep('credentials')
                    setResetSent(false)
                    setError(null)
                  }}
                  className="text-center text-xs text-fg-muted hover:text-fg"
                >
                  {t('common.actions.back')}
                </button>
              </form>
            )}
          </div>
        </div>

        {branding?.loginNote ? (
          <p className="flex items-center gap-2 border-t border-line pt-4 text-xs text-fg-muted">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {branding.loginNote}
          </p>
        ) : null}
      </main>
    </div>
  )
}
