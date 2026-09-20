import { Button, Callout, Field, PasswordInput } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useBranding } from '~/shared/api/branding.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Восстановление доступа по ссылке из письма (`/reset-password?token=…`).
 * Письмо ведёт сюда с фазы 0, а экрана не было — токен терялся, и человек
 * оставался без входа (вопрос N83). Сервер проверяет и гасит токен сам.
 */
export function PasswordResetScreen({ token }: { token: string }) {
  const t = useT()
  const branding = useBranding()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const translate = (message: string) => (message.startsWith('auth.') ? t(message) : message)

  const confirm = useMutation({
    mutationFn: () => http.post('/auth/password-reset/confirm', { token, newPassword: password }),
    onSuccess: () => {
      setError(null)
      setDone(true)
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? translate(Object.values(err.fieldErrors())[0] ?? err.message)
          : t('errors.unknown'),
      ),
  })

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <KeyRound className="size-5" />
          </div>
          <h1 className="text-lg font-semibold text-fg">{branding?.name || 'kchs'}</h1>
          <p className="text-sm text-fg-secondary">{t('auth.reset.subtitle')}</p>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 shadow-md">
          {done ? (
            <div className="flex flex-col gap-3">
              <Callout tone="success">{t('auth.reset.done')}</Callout>
              <Button variant="primary" onClick={() => window.location.assign('/')}>
                {t('auth.reset.signIn')}
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (password !== repeat) {
                  setError(t('auth.reset.mismatch'))
                  return
                }
                confirm.mutate()
              }}
            >
              {error ? <Callout tone="danger">{error}</Callout> : null}
              <Field label={t('auth.reset.newPassword')} hint={t('auth.reset.passwordHint')}>
                <PasswordInput
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </Field>
              <Field label={t('auth.reset.repeat')}>
                <PasswordInput
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                loading={confirm.isPending}
                disabled={password.length === 0}
              >
                {t('auth.reset.confirm')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
