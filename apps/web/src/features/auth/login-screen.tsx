import type { AuthMethods } from '@kchs/contracts'
import { LOCALE_NAMES, LOCALES, type Locale } from '@kchs/i18n'
import { Button, Callout, cn, Field, Input, PasswordInput, SegmentedControl } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Building2, Fingerprint, KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'
import { passkeysSupported, requestPasskey } from '~/shared/auth/webauthn.js'

type Step = 'credentials' | 'mfa' | 'reset'

/** Второй фактор, который принял сервер для этого вызова входа. */
type Factor = 'totp' | 'recovery_code' | 'passkey'

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const setLocale = useAppearance((s) => s.setLocale)

  const [step, setStep] = useState<Step>('credentials')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [resetSent, setResetSent] = useState(false)
  const [factors, setFactors] = useState<Factor[]>(['totp'])

  // Способы входа установки: кнопка IdP и вход по ключу показываются,
  // только если они настроены
  const { data: methods } = useQuery({
    queryKey: ['auth', 'methods'],
    queryFn: () => http.get<AuthMethods>('/auth/methods', { anonymous: true }),
    staleTime: 60_000,
    retry: false,
  })
  const canUseKeys = passkeysSupported() && (methods?.passkeys ?? false)

  // Лимит частоты — понятным текстом со временем ожидания, а не ответом сервера
  const failure = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 429) {
      return t('auth.signIn.tooManyAttempts', { seconds: err.problem.retryAfter ?? 60 })
    }
    return err instanceof ApiError ? err.message : fallback
  }

  const signIn = useMutation({
    mutationFn: () =>
      http.post<{ status: string; csrfToken?: string; methods?: Factor[] }>(
        '/auth/login',
        { login, password, rememberDevice: false },
        { anonymous: true },
      ),
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
    mutationFn: () =>
      http.post<{ csrfToken: string }>(
        '/auth/mfa/verify',
        { challengeId: '', code, trustDevice: false },
        { anonymous: true },
      ),
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => setError(failure(err, t('auth.mfa.invalid'))),
  })

  /** Вход через корпоративный IdP: браузер уходит на страницу провайдера. */
  const startSso = useMutation({
    mutationFn: () => http.post<{ url: string }>('/auth/sso/start', undefined, { anonymous: true }),
    onSuccess: (result) => {
      window.location.assign(result.url)
    },
    onError: (err) => setError(failure(err, t('errors.unknown'))),
  })

  /** Самостоятельный вход по ключу: вызов сервера → подпись устройства → сессия. */
  const signInWithKey = useMutation({
    mutationFn: async () => {
      const options = await http.post<Record<string, unknown>>('/auth/passkey/options', undefined, {
        anonymous: true,
      })
      const credential = await requestPasskey(options)
      return http.post<{ csrfToken: string }>(
        '/auth/passkey/verify',
        { credential },
        { anonymous: true },
      )
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
      const options = await http.post<Record<string, unknown>>(
        '/auth/mfa/passkey/options',
        undefined,
        { anonymous: true },
      )
      const credential = await requestPasskey(options)
      return http.post<{ csrfToken: string }>(
        '/auth/mfa/passkey/verify',
        { credential },
        { anonymous: true },
      )
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
    mutationFn: () => http.post('/auth/password-reset', { login }, { anonymous: true }),
    onSuccess: () => {
      setError(null)
      setResetSent(true)
    },
    onError: (err) => setError(failure(err, t('errors.unknown'))),
  })

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm">
            <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
              <path
                d="M9 8v16M9 16l8-8M9 16l8 8"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-semibold text-fg">kchs</h1>
            <p className="mt-0.5 text-sm text-fg-secondary">{t('auth.signIn.subtitle')}</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 shadow-md">
          {step === 'credentials' ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                signIn.mutate()
              }}
            >
              <h2 className="text-md font-semibold text-fg">{t('auth.signIn.title')}</h2>

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
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
                <div>
                  <h2 className="text-md font-semibold text-fg">{t('auth.mfa.title')}</h2>
                  <p className="mt-0.5 text-xs text-fg-secondary">{t('auth.mfa.subtitle')}</p>
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
              <h2 className="text-md font-semibold text-fg">{t('auth.reset.title')}</h2>
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

        <div className={cn('mt-5 flex justify-center')}>
          <SegmentedControl
            size="sm"
            aria-label={t('common.labels.language')}
            value={locale}
            onValueChange={(next) => setLocale(next as Locale)}
            options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value].short }))}
          />
        </div>
      </div>
    </div>
  )
}
