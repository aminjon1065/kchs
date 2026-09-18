import { Button, Callout, Card, cn, Field, Input, useToast } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { MfaSetup } from '~/features/auth/mfa-setup.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'

/** Второй фактор в профиле: подключение с QR-кодом и отключение по коду. */
export function MfaCard({ enabled }: { enabled: boolean }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const codeId = useId()
  const [disabling, setDisabling] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: keys.me })

  const disable = useMutation({
    mutationFn: () => http.delete<{ ok: boolean }>('/me/mfa', { code: code.trim() }),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(t('auth.mfa.invalid'))
        return
      }
      setDisabling(false)
      setCode('')
      setError(null)
      toast.show({ title: t('auth.mfa.disabledNow'), tone: 'success' })
      refresh()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.code === 'policy_violation'
          ? t('auth.mfa.requiredByPolicy')
          : err instanceof ApiError
            ? err.message
            : t('errors.unknown'),
      ),
  })

  return (
    <Card title={t('auth.mfa.setupTitle')}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck
            className={cn('size-5 shrink-0', enabled ? 'text-success' : 'text-fg-muted')}
            aria-hidden
          />
          <p className="min-w-0 flex-1 text-sm text-fg">
            {enabled ? t('auth.mfa.enabled') : t('auth.mfa.disabled')}
          </p>
          {enabled && !disabling ? (
            <Button variant="secondary" size="sm" onClick={() => setDisabling(true)}>
              {t('auth.mfa.disable')}
            </Button>
          ) : null}
        </div>

        {!enabled ? <MfaSetup onDone={refresh} /> : null}

        {enabled && disabling ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              disable.mutate()
            }}
          >
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <Field label={t('auth.mfa.code')} hint={t('auth.mfa.disableHint')} htmlFor={codeId}>
              <Input
                id={codeId}
                autoComplete="one-time-code"
                maxLength={24}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="max-w-56 font-mono"
              />
            </Field>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="danger"
                disabled={code.trim().length < 6}
                loading={disable.isPending}
              >
                {t('auth.mfa.disable')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDisabling(false)
                  setError(null)
                }}
              >
                {t('common.actions.cancel')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  )
}
