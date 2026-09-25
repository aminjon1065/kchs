import type { HealthAlerts, HealthMetrics } from '@kchs/contracts'
import { formatDateTime, formatFileSize, formatNumber, formatPercent } from '@kchs/fields'
import { Badge, Callout, Card, Skeleton, StatTile } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Activity, Cpu, Database, HardDrive, Search, Server } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { healthQuery } from '~/shared/api/queries.js'

const COMPONENT_ICONS: Record<string, typeof Server> = {
  postgres: Database,
  redis: Activity,
  meilisearch: Search,
  storage: HardDrive,
  engine: Cpu,
}

/**
 * «Здоровье системы»: опрос компонентов, очередь событий и заданий, версия; нагрузка
 * и память служб из Prometheus и действующие оповещения Alertmanager (ADR-0167).
 */
export function HealthSection() {
  const t = useT()
  const { data, isLoading } = useQuery(healthQuery())

  if (isLoading) {
    return (
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    )
  }
  if (!data) return null

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.components.map((component) => {
          const Icon = COMPONENT_ICONS[component.name] ?? Server
          return (
            <div
              key={component.name}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
            >
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-fg-muted" aria-hidden />
                <span className="text-sm font-medium text-fg">{component.name}</span>
                <Badge
                  className="ml-auto"
                  tone={component.status === 'ok' ? 'success' : 'danger'}
                  dot
                  size="sm"
                >
                  {t(`admin.health.${component.status}`)}
                </Badge>
              </div>
              <div className="tabular text-xs text-fg-muted">
                {component.latencyMs !== null
                  ? t('admin.health.latencyMs', { ms: component.latencyMs })
                  : '—'}
              </div>
              {component.detail ? <p className="text-xs text-danger">{component.detail}</p> : null}
            </div>
          )
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label={t('admin.health.outboxPending', { count: data.outbox.pending })}
          value={data.outbox.pending}
        />
        <StatTile label={t('admin.health.jobsQueued')} value={data.jobs.queued} />
        <StatTile label={t('admin.health.jobsRunning')} value={data.jobs.running} />
        <StatTile label={t('admin.health.jobsFailed')} value={data.jobs.failed} />
      </div>

      <AlertsCard alerts={data.alerts} />
      <MetricsCard metrics={data.metrics} />

      <Card title={t('admin.health.installation')}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-fg-muted">{t('admin.health.version')}</dt>
          <dd className="tabular">
            {data.version === 'dev' ? t('admin.health.versionDev') : data.version}
          </dd>
          <dt className="text-fg-muted">{t('admin.health.uptime')}</dt>
          <dd className="tabular">
            {t('admin.health.uptimeMinutes', { minutes: Math.floor(data.uptimeSeconds / 60) })}
          </dd>
          <dt className="text-fg-muted">{t('admin.health.state')}</dt>
          <dd>
            <Badge tone={data.status === 'ok' ? 'success' : 'warning'} dot>
              {t(`admin.health.${data.status}`)}
            </Badge>
          </dd>
        </dl>
      </Card>
    </div>
  )
}

function MetricsCard({ metrics }: { metrics: HealthMetrics }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const number = (value: number | null, precision: number) =>
    value === null ? '—' : formatNumber(value, { precision }, { locale })
  const bytes = (value: number | null) => (value === null ? '—' : formatFileSize(value, { locale }))

  return (
    <Card
      title={t('admin.health.metrics.title')}
      action={<span className="text-xs text-fg-muted">{t('admin.health.metrics.hint')}</span>}
    >
      {metrics.status === 'off' ? (
        <Callout tone="info">{t('admin.health.metrics.off')}</Callout>
      ) : metrics.status === 'unavailable' ? (
        <Callout tone="warning">{t('admin.health.metrics.unavailable')}</Callout>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={t('admin.health.metrics.requests')}
            value={number(metrics.requestsPerSecond, 1)}
          />
          <StatTile
            label={t('admin.health.metrics.errors')}
            value={
              metrics.errorRate === null
                ? '—'
                : formatPercent(metrics.errorRate, { precision: 2 }, { locale })
            }
          />
          <StatTile
            label={t('admin.health.metrics.latency')}
            value={number(metrics.latencyP95Ms, 0)}
            unit={metrics.latencyP95Ms === null ? undefined : t('admin.health.metrics.ms')}
          />
          <StatTile label={t('admin.health.metrics.memory')} value={bytes(metrics.memoryBytes)} />
          <StatTile
            label={t('admin.health.metrics.database')}
            value={bytes(metrics.postgresSizeBytes)}
          />
          <StatTile
            label={t('admin.health.metrics.connections')}
            value={number(metrics.postgresConnections, 0)}
          />
          <StatTile
            label={t('admin.health.metrics.redis')}
            value={bytes(metrics.redisUsedBytes)}
            unit={
              metrics.redisMaxBytes === null
                ? undefined
                : metrics.redisMaxBytes === 0
                  ? t('admin.health.metrics.redisUnbounded')
                  : t('admin.health.metrics.redisOf', {
                      max: formatFileSize(metrics.redisMaxBytes, { locale }),
                    })
            }
          />
        </div>
      )}
    </Card>
  )
}

const SEVERITY_TONE = { critical: 'danger', warning: 'warning' } as const

function AlertsCard({ alerts }: { alerts: HealthAlerts }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)

  return (
    <Card title={t('admin.health.alerts.title')}>
      {alerts.status === 'off' ? (
        <Callout tone="info">{t('admin.health.alerts.off')}</Callout>
      ) : alerts.status === 'unavailable' ? (
        <Callout tone="warning">{t('admin.health.alerts.unavailable')}</Callout>
      ) : alerts.items.length === 0 ? (
        <Callout tone="success">{t('admin.health.alerts.none')}</Callout>
      ) : (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y divide-line">
            {alerts.items.map((alert) => {
              const severity =
                alert.severity === 'critical' || alert.severity === 'warning'
                  ? alert.severity
                  : 'other'
              return (
                <li
                  key={`${alert.name}-${alert.startsAt}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0"
                >
                  <Badge
                    tone={severity === 'other' ? 'neutral' : SEVERITY_TONE[severity]}
                    size="sm"
                  >
                    {t(`admin.health.alerts.severity.${severity}`)}
                  </Badge>
                  <span className="font-mono text-xs text-fg">{alert.name}</span>
                  {alert.summary ? (
                    <span className="min-w-0 flex-1 text-sm text-fg-secondary">
                      {alert.summary}
                    </span>
                  ) : null}
                  <span className="tabular ml-auto text-xs text-fg-muted">
                    {t('admin.health.alerts.since', {
                      time: formatDateTime(alert.startsAt, { locale }),
                    })}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="text-xs text-fg-muted">{t('admin.health.alerts.runbook')}</p>
        </div>
      )}
    </Card>
  )
}
