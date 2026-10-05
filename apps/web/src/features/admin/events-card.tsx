import type { HealthEvents } from '@kchs/contracts'
import { formatDateTime, formatNumber } from '@kchs/fields'
import { Badge, Button, Callout, Card, Skeleton, StatTile, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'

const DLQ_KEY = ['admin', 'events', 'dlq'] as const
const DLQ_LIMIT = 50

/**
 * Шина событий в «Здоровье системы» (ADR-0171): очередь сбоев — события, которые
 * подписчик не обработал после всех попыток, — с повтором и отстающие подписчики.
 */
export function EventsCard({ events }: { events: HealthEvents }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useLocale()

  const dlq = useQuery({
    queryKey: DLQ_KEY,
    queryFn: () => http.get('/admin/events/dlq', { query: { limit: DLQ_LIMIT } }),
    enabled: events.dlq > 0,
  })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: DLQ_KEY })
    void client.invalidateQueries({ queryKey: keys.health })
  }
  const onError = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))

  const retry = useMutation({
    mutationFn: (id: string) => http.post('/admin/events/dlq/:id/retry', { params: { id } }),
    onSuccess: () => {
      refresh()
      toast.show({ title: t('admin.health.events.retried'), tone: 'success' })
    },
    onError,
  })

  const retryAll = useMutation({
    mutationFn: () => http.post('/admin/events/dlq/retry-all'),
    onSuccess: (result) => {
      refresh()
      toast.show({ title: t('admin.health.events.retriedAll', result), tone: 'success' })
    },
    onError,
  })

  const count = (value: number) => formatNumber(value, { precision: 0 }, { locale })

  return (
    <Card
      title={t('admin.health.events.title')}
      action={<span className="text-xs text-fg-muted">{t('admin.health.events.hint')}</span>}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile label={t('admin.health.events.dlq')} value={count(events.dlq)} />
          <StatTile label={t('admin.health.events.lagging')} value={count(events.lagging.length)} />
        </div>

        {events.dlq === 0 && events.lagging.length === 0 ? (
          <Callout tone="success">{t('admin.health.events.ok')}</Callout>
        ) : null}

        {events.lagging.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-fg">{t('admin.health.events.laggingTitle')}</h3>
            <ul className="flex flex-col divide-y divide-line">
              {events.lagging.map((entry) => (
                <li
                  key={entry.subscriber}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
                >
                  <span className="font-mono text-xs text-fg">{entry.subscriber}</span>
                  <span className="tabular text-xs text-fg-secondary">
                    {entry.lag === null
                      ? t('admin.health.events.lagUnknown')
                      : t('admin.health.events.lag', { count: count(entry.lag) })}
                  </span>
                  <span className="tabular text-xs text-fg-secondary">
                    {t('admin.health.events.pending', { count: count(entry.pending) })}
                  </span>
                  {entry.oldestPendingSeconds !== null && entry.oldestPendingSeconds > 0 ? (
                    <span className="tabular ml-auto text-xs text-fg-muted">
                      {t('admin.health.events.oldest', {
                        seconds: count(entry.oldestPendingSeconds),
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {events.dlq > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-fg">{t('admin.health.events.dlqTitle')}</h3>
              <Button
                size="sm"
                variant="primary"
                loading={retryAll.isPending}
                onClick={() => retryAll.mutate()}
              >
                {t('admin.health.events.retryAll')}
              </Button>
            </div>
            <p className="text-xs text-fg-muted">{t('admin.health.events.dlqHint')}</p>
            {dlq.data ? (
              <>
                <ul className="flex flex-col divide-y divide-line">
                  {dlq.data.items.map((entry) => (
                    <li key={entry.id} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Badge tone="danger" size="sm">
                          {entry.subscriber}
                        </Badge>
                        <span className="font-mono text-xs text-fg">{entry.event.type}</span>
                        {entry.event.object?.title ? (
                          <span className="min-w-0 truncate text-sm text-fg-secondary">
                            {entry.event.object.title}
                          </span>
                        ) : null}
                        <span className="tabular ml-auto text-xs text-fg-muted">
                          {formatDateTime(entry.failedAt, { locale })}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={retry.isPending && retry.variables === entry.id}
                          onClick={() => retry.mutate(entry.id)}
                        >
                          {t('admin.health.events.retry')}
                        </Button>
                      </div>
                      <p className="break-words text-xs text-danger">
                        {entry.error}
                        {entry.attempts !== null
                          ? ` · ${t('admin.health.events.attempts', { count: count(entry.attempts) })}`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
                {dlq.data.total > dlq.data.items.length ? (
                  <p className="text-xs text-fg-muted">
                    {t('admin.health.events.shown', {
                      shown: count(dlq.data.items.length),
                      total: count(dlq.data.total),
                    })}
                  </p>
                ) : null}
              </>
            ) : (
              <Skeleton className="h-16 w-full" />
            )}
          </section>
        ) : null}
      </div>
    </Card>
  )
}
