import type { ColumnarCopy } from '@kchs/contracts'
import { formatFileSize, formatNumber, formatRelativeTime } from '@kchs/fields'
import { Badge, Button, Card, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Columns3 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { columnarCopyQuery, dataKeys } from './queries.js'

/** Состояние копии → тон значка. */
const TONE: Record<ColumnarCopy['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  none: 'neutral',
  building: 'warning',
  ready: 'success',
  stale: 'warning',
  failed: 'danger',
}

/**
 * Колоночная копия датасета (06-analytics-engine.md §19, ADR-0109): версия,
 * размер, время сборки и свежесть. Пересобрать может уровень `manage`.
 */
export function ColumnarCard({ datasetId, canManage }: { datasetId: string; canManage: boolean }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data, isLoading } = useQuery(columnarCopyQuery(datasetId))

  const build = useMutation({
    mutationFn: () => http.post<ColumnarCopy>(`/datasets/${datasetId}/columnar/build`, {}),
    onSuccess: (next) => {
      client.setQueryData(dataKeys.columnar(datasetId), next)
      toast.show({ title: t('data.columnar.buildStarted'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (isLoading) return <Skeleton className="h-24" />
  // Датасет маленький и копии нет — раздел не нужен
  if (!data || (data.status === 'none' && !data.eligible)) return null

  const rows = data.rowCount === null ? null : formatNumber(data.rowCount, {}, { locale })
  return (
    <Card title={t('data.columnar.title')}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Columns3 className="size-4 shrink-0 text-fg-muted" aria-hidden />
          <Badge tone={TONE[data.status]}>{t(`data.columnar.statuses.${data.status}`)}</Badge>
          {data.status === 'ready' || data.status === 'stale' ? (
            <span className="text-xs text-fg-secondary">
              {t('data.columnar.version', { number: data.version ?? 0 })}
            </span>
          ) : null}
          {canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="ml-auto"
              loading={build.isPending}
              disabled={data.status === 'building'}
              onClick={() => build.mutate()}
            >
              {t('data.columnar.rebuild')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-fg-secondary">
          {data.status === 'stale'
            ? t('data.columnar.staleHint', { number: data.datasetVersion })
            : t('data.columnar.hint')}
        </p>
        {data.error ? <p className="text-xs text-danger-fg">{data.error}</p> : null}
        {data.builtAt ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <Metric label={t('data.columnar.builtAt')}>
              {formatRelativeTime(data.builtAt, { locale })}
            </Metric>
            <Metric label={t('data.columnar.size')}>
              {data.sizeBytes === null ? '—' : formatFileSize(data.sizeBytes, { locale })}
            </Metric>
            <Metric label={t('data.columnar.rows')}>{rows ?? '—'}</Metric>
            <Metric label={t('data.columnar.buildTime')}>
              {data.buildMs === null
                ? '—'
                : t('data.columnar.seconds', { value: (data.buildMs / 1000).toFixed(1) })}
            </Metric>
          </dl>
        ) : null}
      </div>
    </Card>
  )
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular text-fg">{children}</dd>
    </div>
  )
}
