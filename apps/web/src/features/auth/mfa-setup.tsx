import type { MfaSetupResponse } from '@kchs/contracts'
import { Button, Callout, Checkbox, Field, IconButton, Input, useToast } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { Copy, Download, ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

type Stage =
  | { kind: 'start' }
  | { kind: 'scan'; setup: MfaSetupResponse }
  | { kind: 'codes'; codes: string[] }

/** Ключ группами по четыре символа — так его проще перепечатать с экрана. */
const groupKey = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim()

/**
 * Подключение TOTP (17-security.md §2): QR-код или ключ вручную → код из
 * приложения → коды восстановления, которые показываются один раз.
 * Новый ключ создаётся только по кнопке: повторный запрос заменил бы ключ,
 * уже отсканированный приложением.
 */
export function MfaSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const t = useT()
  const toast = useToast()
  const codeId = useId()
  const [stage, setStage] = useState<Stage>({ kind: 'start' })
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const failed = (err: unknown) => {
    const message = err instanceof ApiError ? Object.values(err.fieldErrors())[0] : undefined
    setError(
      message?.startsWith('auth.')
        ? t(message)
        : err instanceof ApiError
          ? err.message
          : t('errors.unknown'),
    )
  }

  const start = useMutation({
    mutationFn: () => http.post<MfaSetupResponse>('/me/mfa/setup'),
    onSuccess: (setup) => {
      setError(null)
      setStage({ kind: 'scan', setup })
    },
    onError: failed,
  })

  const confirm = useMutation({
    mutationFn: () => http.post<{ codes: string[] }>('/me/mfa/enable', { code }),
    onSuccess: (result) => {
      setError(null)
      setStage({ kind: 'codes', codes: result.codes })
    },
    onError: failed,
  })

  const copy = async (text: string, message: string) => {
    await navigator.clipboard.writeText(text)
    toast.show({ title: message, tone: 'success' })
  }

  const download = (codes: string[]) => {
    const text = [t('auth.mfa.codesFileTitle'), '', ...codes, ''].join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'kchs-recovery-codes.txt'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (stage.kind === 'start') {
    return (
      <div className="flex flex-col gap-3">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <p className="text-xs text-fg-secondary">{t('auth.mfa.setupHint')}</p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            icon={<ShieldCheck className="size-4" />}
            loading={start.isPending}
            onClick={() => start.mutate()}
          >
            {t('auth.mfa.enable')}
          </Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {t('common.actions.cancel')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (stage.kind === 'scan') {
    const { setup } = stage
    return (
      <form
        className="flex flex-col gap-4 sm:flex-row sm:items-start"
        onSubmit={(event) => {
          event.preventDefault()
          confirm.mutate()
        }}
      >
        <div className="flex shrink-0 flex-col items-center gap-2">
          {/* QR — изображение с белым полем: читается камерой в любой теме */}
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
            alt={t('auth.mfa.qrAlt')}
            width={176}
            height={176}
            className="rounded-sm border border-line"
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="text-xs text-fg-secondary">{t('auth.mfa.setupHint')}</p>
          <div>
            <p className="text-2xs text-fg-muted">{t('auth.mfa.manualKey')}</p>
            <div className="mt-1 flex items-center gap-1">
              <code className="min-w-0 break-all font-mono text-xs text-fg">
                {groupKey(setup.secret)}
              </code>
              <IconButton
                size="sm"
                label={t('auth.mfa.copyKey')}
                onClick={() => void copy(setup.secret, t('auth.mfa.keyCopied'))}
              >
                <Copy className="size-3.5" />
              </IconButton>
            </div>
          </div>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('auth.mfa.confirmCode')} htmlFor={codeId}>
            <Input
              id={codeId}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              className="max-w-40 font-mono tracking-widest"
            />
          </Field>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={code.length !== 6}
              loading={confirm.isPending}
            >
              {t('auth.mfa.submit')}
            </Button>
            {onCancel ? (
              <Button variant="ghost" onClick={onCancel}>
                {t('common.actions.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Callout tone="success">{t('auth.mfa.enabled')}</Callout>
      <div>
        <h3 className="text-sm font-semibold text-fg">{t('auth.mfa.recoveryTitle')}</h3>
        <p className="mt-0.5 text-xs text-fg-secondary">{t('auth.mfa.recoveryHint')}</p>
      </div>
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-line bg-surface-2 p-3 font-mono text-sm text-fg">
        {stage.codes.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={() => void copy(stage.codes.join('\n'), t('auth.mfa.codesCopied'))}
        >
          {t('auth.mfa.copyCodes')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download className="size-3.5" />}
          onClick={() => download(stage.codes)}
        >
          {t('auth.mfa.downloadCodes')}
        </Button>
      </div>
      <Checkbox
        id={`${codeId}-saved`}
        checked={saved}
        onCheckedChange={(next) => setSaved(next === true)}
        label={t('auth.mfa.savedCheck')}
      />
      <div>
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          {t('common.actions.done')}
        </Button>
      </div>
    </div>
  )
}
