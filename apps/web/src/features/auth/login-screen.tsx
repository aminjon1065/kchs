import { LOCALE_NAMES, LOCALES, type Locale } from '@kchs/i18n'
import { Button, Callout, cn, Field, Input, PasswordInput, SegmentedControl } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'

type Step = 'credentials' | 'mfa' | 'reset'

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

  const signIn = useMutation({
    mutationFn: () =>
      http.post<{ status: string; csrfToken?: string }>(
        '/auth/login',
        { login, password, rememberDevice: false },
        { anonymous: true },
      ),
    onSuccess: (result) => {
      setError(null)
      if (result.status === 'mfa_required') {
        setStep('mfa')
        return
      }
      if (result.csrfToken) setCsrfToken(result.csrfToken)
      onSignedIn()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
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
    onError: (err) => setError(err instanceof ApiError ? err.message : t('auth.mfa.invalid')),
  })

  const requestReset = useMutation({
    mutationFn: () => http.post('/auth/password-reset', { login }, { anonymous: true }),
    onSuccess: () => setResetSent(true),
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
