import { Button, Callout, Field, PasswordInput } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut } from 'lucide-react'
import { useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http, setCsrfToken } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'

/**
 * Вход по временному паролю (выдан администратором): пока пароль не сменён,
 * сервер отвечает на всё, кроме профиля и смены пароля, кодом
 * `password_change_required` (17-security.md §2) — оболочку не показываем.
 */
export function PasswordChangeScreen() {
  const t = useT()
  const client = useQueryClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)

  const translate = (message: string) => (message.startsWith('auth.') ? t(message) : message)

  const change = useMutation({
    mutationFn: () =>
      http.post('/me/password', { currentPassword, newPassword, revokeOtherSessions: true }),
    onSuccess: () => {
      setError(null)
      void client.invalidateQueries({ queryKey: keys.me })
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? translate(Object.values(err.fieldErrors())[0] ?? err.message)
          : t('errors.unknown'),
      ),
  })

  const signOut = useMutation({
    mutationFn: () => http.post('/auth/logout'),
    onSettled: () => {
      setCsrfToken(null)
      window.location.reload()
    },
  })

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px] rounded-lg border border-line bg-surface p-5 shadow-md">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (newPassword !== repeat) {
              setError(t('auth.password.mismatch'))
              return
            }
            change.mutate()
          }}
        >
          <div className="flex items-start gap-2.5">
            <KeyRound className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
            <div>
              <h1 className="text-md font-semibold text-fg">
                {t('auth.password.mustChangeTitle')}
              </h1>
              <p className="mt-0.5 text-xs text-fg-secondary">
                {t('auth.password.mustChangeHint')}
              </p>
            </div>
          </div>

          {error ? <Callout tone="danger">{error}</Callout> : null}

          <Field label={t('auth.password.temporary')} htmlFor="temporary-password">
            <PasswordInput
              id="temporary-password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </Field>
          <Field
            label={t('auth.reset.newPassword')}
            htmlFor="new-password"
            hint={t('auth.password.minLengthHint')}
          >
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={12}
              required
            />
          </Field>
          <Field label={t('auth.password.repeat')} htmlFor="repeat-password">
            <PasswordInput
              id="repeat-password"
              autoComplete="new-password"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              minLength={12}
              required
            />
          </Field>

          <Button type="submit" variant="primary" block loading={change.isPending}>
            {t('auth.reset.confirm')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            block
            icon={<LogOut className="size-4" />}
            onClick={() => signOut.mutate()}
          >
            {t('auth.signOut')}
          </Button>
        </form>
      </div>
    </div>
  )
}
