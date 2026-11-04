import { Tooltip, useToast } from '@kchs/ui'
import { useQueryClient } from '@tanstack/react-query'
import { CloudUpload, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useT } from '~/shared/i18n.js'
import { onOfflineDocumentSent, onOfflineFailed, useOfflineQueue } from '~/shared/offline/queue.js'

/**
 * Сообщения офлайн-очереди (ADR-0212, ADR-0228). Живут в оболочке, а не в строке
 * состояния: на телефоне её нет, а донесение, ушедшее или отклонённое после закрытия
 * диалога, должно быть видно и там.
 */
export function OfflineQueueSignals() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()

  useEffect(
    () =>
      onOfflineDocumentSent((_, sent) => {
        if (sent.intake === 'sent' || sent.intake === 'registered') {
          toast.success(t('shell.status.reportSent'))
        } else {
          toast.show({ title: t('shell.status.reportSaved') })
        }
        void client.invalidateQueries({ queryKey: ['documents'] })
      }),
    [client, t, toast],
  )

  // Отказ по существу: экран давно закрыт, а счётчик «ждут сети» просто погас бы
  useEffect(
    () =>
      onOfflineFailed((entry) => {
        toast.error(
          t('shell.status.offlineFailedToast', { error: entry.error ?? '' }),
          t('shell.status.offlineFailedHint'),
        )
      }),
    [t, toast],
  )

  return null
}

/** Сколько отправок ждут сети и сколько отклонено: строка состояния и полоса телефона. */
export function useOfflineCounts(): { waiting: number; failed: number } {
  const entries = useOfflineQueue()
  return {
    waiting: entries.filter((entry) => entry.state === 'pending').length,
    failed: entries.filter((entry) => entry.state === 'failed').length,
  }
}

/** Признаки очереди: «ждут сети» и «не прошли» (на телефоне — над нижней панелью). */
export function OfflineQueueIndicators() {
  const t = useT()
  const { waiting, failed } = useOfflineCounts()
  return (
    <>
      {waiting > 0 ? (
        <Tooltip content={t('shell.status.offlineQueueHint')}>
          <span className="flex items-center gap-1.5 text-warning">
            <CloudUpload className="size-3" aria-hidden />
            {t('shell.status.offlineQueue', { count: waiting })}
          </span>
        </Tooltip>
      ) : null}
      {failed > 0 ? (
        <Tooltip content={t('shell.status.offlineFailedHint')}>
          <span className="flex items-center gap-1.5 text-danger">
            <TriangleAlert className="size-3" aria-hidden />
            {t('shell.status.offlineFailed', { count: failed })}
          </span>
        </Tooltip>
      ) : null}
    </>
  )
}

/** Телефон: строки состояния нет — признаки очереди полосой над нижней панелью. */
export function MobileOfflineStrip() {
  const { waiting, failed } = useOfflineCounts()
  if (waiting === 0 && failed === 0) return null
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-t border-line bg-surface-2 px-3 py-1 text-2xs"
    >
      <OfflineQueueIndicators />
    </div>
  )
}
