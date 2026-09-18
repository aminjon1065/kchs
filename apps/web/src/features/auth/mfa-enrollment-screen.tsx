import { Button } from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LogOut, ShieldAlert } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { http, setCsrfToken } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { MfaSetup } from './mfa-setup.js'

/**
 * Политика безопасности требует второй фактор для роли пользователя, а он не
 * подключён: сервер отвечает на всё, кроме профиля и подключения MFA, кодом
 * `mfa_enrollment_required` (17-security.md §2) — оболочку не показываем.
 */
export function MfaEnrollmentScreen() {
  const t = useT()
  const client = useQueryClient()

  const signOut = useMutation({
    mutationFn: () => http.post('/auth/logout'),
    onSettled: () => {
      setCsrfToken(null)
      window.location.reload()
    },
  })

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10">
      <div className="flex w-full max-w-[560px] flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-md">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <div>
            <h1 className="text-md font-semibold text-fg">{t('auth.mfa.requiredTitle')}</h1>
            <p className="mt-0.5 text-xs text-fg-secondary">{t('auth.mfa.requiredHint')}</p>
          </div>
        </div>

        <MfaSetup onDone={() => void client.invalidateQueries({ queryKey: keys.me })} />

        <div className="border-t border-line pt-3">
          <Button
            variant="ghost"
            size="sm"
            icon={<LogOut className="size-3.5" />}
            loading={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {t('auth.signOut')}
          </Button>
        </div>
      </div>
    </div>
  )
}
