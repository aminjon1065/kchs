import { Button, EmptyState } from '@kchs/ui'
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode, useSyncExternalStore } from 'react'
import { useT } from '~/shared/i18n.js'

/**
 * Границы ошибок (ADR-0228): падение одного экрана не роняет рабочее пространство.
 * Граница стоит на каждой вкладке, в контекст-панели и в корне приложения.
 */

/** Модуль экрана не загрузился: нет сети или после выкатки в кэше старые адреса чанков. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ChunkLoadError') return true
  return /dynamically imported module|Importing a module script failed|Unable to preload|module script/i.test(
    error.message,
  )
}

interface BoundaryState {
  failed: boolean
  error: unknown
}

interface BoundaryProps {
  children: ReactNode
  fallback: (props: { error: unknown; reset: () => void }) => ReactNode
  onError?: (error: unknown, info: ErrorInfo) => void
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info)
    // Для разработчика и журнала браузера: что именно упало и где
    console.error(error, info.componentStack)
  }

  reset = (): void => this.setState({ failed: false, error: null })

  override render(): ReactNode {
    if (this.state.failed)
      return this.props.fallback({ error: this.state.error, reset: this.reset })
    return this.props.children
  }
}

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

/** Есть ли сеть — для текста ошибки: без сети перезагрузка не поможет. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  )
}

/**
 * Что показать вместо упавшего экрана. Модуль не загрузился без сети — экран
 * откроется, когда связь вернётся; со связью — вышла новая версия, нужна
 * перезагрузка. Остальное — ошибка показа: повторить или закрыть вкладку.
 */
export function ViewErrorFallback({
  error,
  reset,
  onClose,
}: {
  error: unknown
  reset: () => void
  onClose?: () => void
}) {
  const t = useT()
  const online = useOnline()
  const close = onClose ? (
    <Button variant="ghost" onClick={onClose}>
      {t('shell.viewError.closeTab')}
    </Button>
  ) : null

  if (isChunkLoadError(error)) {
    return (
      <EmptyState
        icon={online ? <RefreshCw /> : <WifiOff />}
        title={online ? t('shell.viewError.versionTitle') : t('shell.viewError.offlineTitle')}
        description={online ? t('shell.viewError.versionHint') : t('shell.viewError.offlineHint')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" disabled={!online} onClick={() => window.location.reload()}>
              {t('shell.viewError.reload')}
            </Button>
            {close}
          </div>
        }
      />
    )
  }

  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={t('shell.viewError.title')}
      description={t('shell.viewError.hint')}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onClick={reset}>
            {t('shell.viewError.retry')}
          </Button>
          {close}
        </div>
      }
    />
  )
}

/** Граница вкладки или панели: экран упал — вместо него объяснение и выход. */
export function ViewBoundary({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <ViewErrorFallback error={error} reset={reset} onClose={onClose} />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/** Последний рубеж: упало само приложение — экран с перезагрузкой вместо белого листа. */
export function AppErrorFallback() {
  const t = useT()
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <EmptyState
        icon={<AlertTriangle />}
        title={t('shell.appError.title')}
        description={t('shell.appError.hint')}
        action={
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t('shell.appError.reload')}
          </Button>
        }
      />
    </div>
  )
}
