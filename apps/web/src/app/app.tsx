import { Button, EmptyState, Spinner } from '@kchs/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WifiOff } from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { useBranding } from '~/shared/api/branding.js'
import { ApiError } from '~/shared/api/errors.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import {
  setCsrfToken,
  setSetupRequiredHandler,
  setUnauthorizedHandler,
} from '~/shared/api/session.js'
import { initAppearance } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { forgetProfile } from '~/shared/offline/profile.js'
import { isRetryable } from '~/shared/offline/queue.js'
import { prepareOffline } from '~/shared/offline/warmup.js'
import { loadOfflineModules } from '~/shared/workspace/registry.js'
import { forgetWorkspace } from '~/shared/workspace/store.js'
import {
  GuestMeetingScreen,
  GuestShareScreen,
  LoginScreen,
  MfaEnrollmentScreen,
  PasswordChangeScreen,
  PasswordResetScreen,
  PrintScreen,
  printTargetFromPath,
  registerModules,
} from './modules.js'
import { WorkspaceShell } from './workspace/shell.js'

registerModules()

/** Гостевая ссылка обслуживается вне рабочего пространства: `/s/<токен>`. */
function shareTokenFromUrl(): string | null {
  const match = /^\/s\/([A-Za-z0-9_-]{8,128})$/.exec(window.location.pathname)
  return match?.[1] ?? null
}

/** Восстановление доступа по ссылке из письма: `/reset-password?token=…`. */
function resetTokenFromUrl(): string | null {
  if (window.location.pathname !== '/reset-password') return null
  const token = new URLSearchParams(window.location.search).get('token')
  return token && /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : null
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
  // Сотрудник, чья оболочка открыта: сессия кончилась посреди работы — вход поверх
  // оболочки, без её размонтирования (ADR-0228)
  const shellUser = useRef<string | null>(null)
  const [shareToken] = useState(shareTokenFromUrl)
  const [resetToken] = useState(resetTokenFromUrl)
  const [meetToken] = useState(meetTokenFromUrl)
  // Печать (03-screens.md §21): вне оболочки, без входа — у движка токен печати
  const [printTarget] = useState(() =>
    printTargetFromPath(window.location.pathname, window.location.search),
  )

  useEffect(() => {
    initAppearance()
    setUnauthorizedHandler(() => {
      setCsrfToken(null)
      setSignedOut(true)
      // Оболочка открыта — кэш не стираем: открытые формы и вкладки ждут повторного входа
      if (!shellUser.current) client.clear()
      // Сессии больше нет — и без сети приложение от её имени не откроется (ADR-0207)
      void forgetProfile()
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
    refetch,
  } = useQuery({
    ...meQuery(),
    enabled: !signedOut && !shareToken && !meetToken && !printTarget && !resetToken,
  })

  // Токен CSRF восстанавливается из /me: сессия переживает перезагрузку вкладки
  useEffect(() => {
    if (me?.session.csrfToken) setCsrfToken(me.session.csrfToken)
  }, [me])

  // После входа, в простое — экраны сводок в кэш служебного потока (ADR-0207)
  const signedIn = Boolean(me?.user.id)
  useEffect(() => {
    if (!signedIn) return
    const timer = window.setTimeout(() => void prepareOffline(loadOfflineModules), 5000)
    return () => window.clearTimeout(timer)
  }, [signedIn])

  if (resetToken) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <PasswordResetScreen token={resetToken} />
      </Suspense>
    )
  }
  if (shareToken) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <GuestShareScreen token={shareToken} />
      </Suspense>
    )
  }
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

  // Сессия кончилась посреди работы (простой, отзыв): вход поверх оболочки. Тот же
  // сотрудник — работа продолжается; другой — всё сбрасывается, как при выходе
  if (signedOut && shellUser.current && me) {
    const resume = async () => {
      const previous = shellUser.current
      const fresh = await client.fetchQuery({ ...meQuery(), staleTime: 0 }).catch(() => null)
      if (fresh && fresh.user.id !== previous) {
        forgetWorkspace()
        client.clear()
        window.location.reload()
        return
      }
      setSignedOut(false)
      void client.invalidateQueries()
    }
    return (
      <ShellFrame
        overlay={
          <ReauthOverlay>
            <Suspense fallback={<ScreenLoading />}>
              <LoginScreen onSignedIn={() => void resume()} />
            </Suspense>
          </ReauthOverlay>
        }
      />
    )
  }

  if (signedOut || (isError && error instanceof ApiError && error.status === 401)) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <LoginScreen
          onSignedIn={() => {
            setSignedOut(false)
            void client.invalidateQueries()
          }}
        />
      </Suspense>
    )
  }

  // Нет сети, а на устройстве никто не вошёл: объяснить, а не крутить загрузку (ADR-0207)
  if (!me && isError && isRetryable(error)) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6">
        <EmptyState
          icon={<WifiOff className="size-5" />}
          title={t('shell.offlineStart.title')}
          description={t('shell.offlineStart.hint')}
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              {t('shell.offlineStart.retry')}
            </Button>
          }
        />
      </div>
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
  if (me.mustChangePassword) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <PasswordChangeScreen />
      </Suspense>
    )
  }
  // Политика требует второй фактор для роли: до подключения оболочка недоступна
  if (me.mfaEnrollmentRequired) {
    return (
      <Suspense fallback={<ScreenLoading />}>
        <MfaEnrollmentScreen />
      </Suspense>
    )
  }

  shellUser.current = me.user.id
  return <ShellFrame />
}

/**
 * Оболочка в одной и той же обёртке и с входом поверх, и без: смена ветки не
 * размонтирует рабочее пространство вместе с несохранёнными формами (ADR-0228).
 */
function ShellFrame({ overlay }: { overlay?: ReactNode }) {
  const covered = overlay !== undefined
  return (
    <>
      <div className="h-full" inert={covered || undefined} aria-hidden={covered || undefined}>
        <WorkspaceShell />
      </div>
      {overlay}
    </>
  )
}

/** Вход поверх оболочки: оболочку не видно и не достать с клавиатуры, пока не вошли. */
function ReauthOverlay({ children }: { children: ReactNode }) {
  const t = useT()
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('shell.reauth.label')}
      className="fixed inset-0 z-(--z-modal) overflow-auto bg-canvas"
    >
      <p className="mx-auto mt-6 max-w-[400px] px-4 text-center text-sm text-fg-secondary">
        {t('shell.reauth.hint')}
      </p>
      {children}
    </div>
  )
}

/** Пока грузится чанк экрана вне оболочки — тот же индикатор, что у загрузки пространства. */
function ScreenLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <Spinner className="size-6" />
    </div>
  )
}
