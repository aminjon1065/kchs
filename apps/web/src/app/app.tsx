import { Spinner } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { LoginScreen } from '~/features/auth/login-screen.js'
import { MfaEnrollmentScreen } from '~/features/auth/mfa-enrollment-screen.js'
import { PasswordChangeScreen } from '~/features/auth/password-change-screen.js'
import { printTargetFromPath } from '~/features/reports/print/print-target.js'
import { GuestShareScreen } from '~/features/share/guest-screen.js'
import { useBranding } from '~/shared/api/branding.js'
import {
  ApiError,
  setCsrfToken,
  setSetupRequiredHandler,
  setUnauthorizedHandler,
} from '~/shared/api/client.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import { initAppearance } from './appearance.js'
import { useT } from './i18n.js'
import { registerModules } from './modules.js'
import { WorkspaceShell } from './workspace/shell.js'

registerModules()

/** Страница печати отчёта — отдельным чанком: оболочке она не нужна (ADR-0078). */
const PrintScreen = lazy(() => import('~/features/reports/print/print-screen.js'))

/** Комната гостя — отдельным чанком: клиент медиасервера нужен только ей. */
const GuestMeetingScreen = lazy(async () => ({
  default: (await import('~/features/meetings/guest-screen.js')).GuestMeetingScreen,
}))

/** Гостевая ссылка обслуживается вне рабочего пространства: `/s/<токен>`. */
function shareTokenFromUrl(): string | null {
  const match = /^\/s\/([A-Za-z0-9_-]{8,128})$/.exec(window.location.pathname)
  return match?.[1] ?? null
}

/** Гость во встрече — тоже вне оболочки: `/meet/<токен>` (ADR-0091). */
function meetTokenFromUrl(): string | null {
  const match = /^\/meet\/([A-Za-z0-9_.-]{40,200})$/.exec(window.location.pathname)
  return match?.[1] ?? null
}

export function App() {
  const t = useT()
  const client = useQueryClient()
  // Акцент и заголовок окна — из брендирования установки (15-admin-operations.md §1)
  useBranding()
  const [signedOut, setSignedOut] = useState(false)
  const [shareToken] = useState(shareTokenFromUrl)
  const [meetToken] = useState(meetTokenFromUrl)
  // Печать (03-screens.md §21): вне оболочки, без входа — у движка токен печати
  const [printTarget] = useState(() => printTargetFromPath(window.location.pathname))

  useEffect(() => {
    initAppearance()
    setUnauthorizedHandler(() => {
      setCsrfToken(null)
      setSignedOut(true)
      client.clear()
    })
    setSetupRequiredHandler(() => void client.invalidateQueries({ queryKey: keys.me }))
    return () => {
      setUnauthorizedHandler(null)
      setSetupRequiredHandler(null)
    }
  }, [client])

  const {
    data: me,
    isLoading,
    isError,
    error,
  } = useQuery({
    ...meQuery(),
    enabled: !signedOut && !shareToken && !meetToken && !printTarget,
  })

  // Токен CSRF восстанавливается из /me: сессия переживает перезагрузку вкладки
  useEffect(() => {
    if (me?.session.csrfToken) setCsrfToken(me.session.csrfToken)
  }, [me])

  if (shareToken) return <GuestShareScreen token={shareToken} />
  if (meetToken) {
    return (
      <Suspense fallback={null}>
        <GuestMeetingScreen token={meetToken} />
      </Suspense>
    )
  }
  if (printTarget) {
    return (
      <Suspense fallback={null}>
        <PrintScreen target={printTarget} />
      </Suspense>
    )
  }

  if (signedOut || (isError && error instanceof ApiError && error.status === 401)) {
    return (
      <LoginScreen
        onSignedIn={() => {
          setSignedOut(false)
          void client.invalidateQueries()
        }}
      />
    )
  }

  if (isLoading || !me) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="size-6" />
          <span className="text-sm text-fg-muted">{t('shell.loadingWorkspace')}</span>
        </div>
      </div>
    )
  }

  // Вход по временному паролю: до смены пароля оболочка недоступна
  if (me.mustChangePassword) return <PasswordChangeScreen />
  // Политика требует второй фактор для роли: до подключения оболочка недоступна
  if (me.mfaEnrollmentRequired) return <MfaEnrollmentScreen />

  return <WorkspaceShell />
}
