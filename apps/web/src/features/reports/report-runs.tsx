import type {
  ReportDeliveryChannel,
  ReportFormat,
  ReportRunRecord,
  ReportRunStatus,
} from '@kchs/contracts'
import { formatDateTime, formatFileSize, formatNumber } from '@kchs/fields'
import { Badge, Button, EmptyState, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, FileClock } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { reportRunsQuery } from './queries.js'

const STATUS_TONE: Record<
  ReportRunStatus,
  'neutral' | 'accent' | 'success' | 'danger' | 'warning'
> = {
  queued: 'neutral',
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'warning',
}

const CHANNELS: ReportDeliveryChannel[] = ['inbox', 'email', 'telegram']

function RunItem({ run }: { run: ReportRunRecord }) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const download = useMutation({
    mutationFn: (format: ReportFormat) =>
      http.get<{ url: string }>(`/reports/runs/${run.id}/download`, { query: { format } }),
    onSuccess: ({ url }) => {
      window.location.assign(url)
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const delivered = CHANNELS.filter((channel) => run.delivery[channel])
  return (
    <li className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={STATUS_TONE[run.status]} size="sm">
          {t(`data.report.runs.status.${run.status}`)}
        </Badge>
        <span className="text-2xs text-fg-muted tabular">
          {formatDateTime(run.createdAt, { locale })}
        </span>
      </div>
      <p className="text-xs text-fg-secondary">
        {t(`data.report.runs.trigger.${run.trigger}`)} · {run.runAs.displayName}
      </p>
      {run.status === 'succeeded' ? (
        <p className="text-2xs text-fg-muted tabular">
          {[
            run.pages !== null ? t('data.report.runs.pages', { count: run.pages }) : null,
            run.durationMs !== null
              ? t('data.report.runs.duration', {
                  seconds: formatNumber(run.durationMs / 1000, { precision: 1 }, { locale }),
                })
              : null,
            formatFileSize(
              run.files.reduce((sum, file) => sum + file.size, 0),
              { locale },
            ),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {run.error ? <p className="text-2xs text-danger">{run.error}</p> : null}
      {delivered.length > 0 ? (
        <p className="text-2xs text-fg-muted">
          {delivered
            .map(
              (channel) =>
                `${t(`data.report.channels.${channel}`)}: ${t(
                  `data.report.runs.delivery.${run.delivery[channel]}`,
                )}`,
            )
            .join(' · ')}
        </p>
      ) : null}
      {run.canDownload && run.files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {run.files.map((file) => (
            <Button
              key={file.format}
              variant="secondary"
              size="sm"
              icon={<Download className="size-3.5" />}
              loading={download.isPending && download.variables === file.format}
              onClick={() => download.mutate(file.format)}
              aria-label={t('data.report.runs.downloadFile', { name: file.fileName })}
            >
              {file.format.toUpperCase()}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

/**
 * История запусков отчёта (ADR-0078): свои запуски и — управляющему — все;
 * скачать файл может только тот, под чьими правами он построен.
 */
export function ReportRunsPanel({ reportId }: { reportId: string }) {
  const t = useT()
  const { data: runs, isLoading } = useQuery(reportRunsQuery(reportId))
  return (
    <section aria-label={t('data.report.runs.title')} className="flex min-h-0 flex-col">
      <h2 className="border-b border-line px-3 py-2 text-xs font-semibold text-fg">
        {t('data.report.runs.title')}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : !runs || runs.length === 0 ? (
          <EmptyState compact icon={<FileClock />} title={t('data.report.runs.empty')} />
        ) : (
          <ul aria-label={t('data.report.runs.title')}>
            {runs.map((run) => (
              <RunItem key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
