import { Spinner } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { LoginScreen } from '~/features/auth/login-screen.js'
import { PasswordChangeScreen } from '~/features/auth/password-change-screen.js'
import { GuestShareScreen } from '~/features/share/guest-screen.js'
import { ApiError, setCsrfToken, setUnauthorizedHandler } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { initAppearance } from './appearance.js'
import { useT } from './i18n.js'
import { registerModules } from './modules.js'
import { WorkspaceShell } from './workspace/shell.js'

registerModules()

/** Гостевая ссылка обслуживается вне рабочего пространства: `/s/<токен>`. */
function shareTokenFromUrl(): string | null {
  const match = /^\/s\/([A-Za-z0-9_-]{8,128})$/.exec(window.location.pathname)
  return match?.[1] ?? null
}

export function App() {
  const t = useT()
  const client = useQueryClient()
  const [signedOut, setSignedOut] = useState(false)
  const [shareToken] = useState(shareTokenFromUrl)

  useEffect(() => {
    initAppearance()
    setUnauthorizedHandler(() => {
      setCsrfToken(null)
      setSignedOut(true)
      client.clear()
    })
    return () => setUnauthorizedHandler(null)
  }, [client])

  const {
    data: me,
    isLoading,
    isError,
    error,
  } = useQuery({ ...meQuery(), enabled: !signedOut && !shareToken })

  // Токен CSRF восстанавливается из /me: сессия переживает перезагрузку вкладки
  useEffect(() => {
    if (me?.session.csrfToken) setCsrfToken(me.session.csrfToken)
  }, [me])

  if (shareToken) return <GuestShareScreen token={shareToken} />

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

  return <WorkspaceShell />
}
