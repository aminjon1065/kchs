import { Button, EmptyState, ErrorState, NoAccessState } from '@kchs/ui'
import { WifiOff } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError } from '~/shared/api/errors.js'
import { useT } from '~/shared/i18n.js'

/** Запрос не дошёл до api: нет сети или шлюз не дождался ответа — это не «не найдено». */
function unreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return error instanceof ApiError && [0, 502, 503, 504].includes(error.status)
}

/**
 * Экран не загрузил свой объект (ADR-0228): «не найдено» — только когда сервер так и
 * ответил (404) или объекта нет; нет доступа, нет связи и сбой сервера — свои тексты,
 * а у временных — «Повторить».
 */
export function LoadFailure({
  error,
  onRetry,
  notFoundTitle,
  icon,
}: {
  error: unknown
  onRetry?: () => void
  /** Текст «не найдено» экрана; по умолчанию общий. */
  notFoundTitle?: string
  icon?: ReactNode
}) {
  const t = useT()
  if (error instanceof ApiError && error.status === 403) return <NoAccessState />
  if (unreachable(error)) {
    return (
      <EmptyState
        icon={<WifiOff />}
        title={t('shell.loadError.offlineTitle')}
        description={t('shell.loadError.offlineHint')}
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              {t('shell.viewError.retry')}
            </Button>
          ) : null
        }
      />
    )
  }
  if (error && !(error instanceof ApiError && error.status === 404)) {
    return (
      <ErrorState
        description={error instanceof ApiError ? error.message : undefined}
        onRetry={onRetry}
      />
    )
  }
  return <EmptyState icon={icon} title={notFoundTitle ?? t('common.states.notFound')} />
}
