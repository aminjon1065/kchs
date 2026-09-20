import { formatDateTime, formatFileSize } from '@kchs/fields'
import { Badge, Button, Callout, Card, EmptyState, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'

interface BackupRecord {
  id: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt: string | null
  sizeBytes: number | null
  error: string | null
  verifiedAt: string | null
  verifiedNote: string | null
}

const KEY = ['admin', 'backups'] as const

/**
 * Резервные копии и обслуживание (15-admin-operations.md §5–6): список
 * прогонов `pg_dump`, копия по требованию, отметка о проверке восстановлением
 * и переиндексация поиска. Остальные регулярные работы — в «Расписаниях».
 */
export function BackupsSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => http.get<{ items: BackupRecord[] }>('/admin/backups'),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 5_000 : false,
  })

  const run = useMutation({
    mutationFn: () => http.post<BackupRecord>('/admin/backups'),
    onSuccess: (record) => {
      void client.invalidateQueries({ queryKey: KEY })
      if (record.status === 'failed') toast.error(record.error ?? t('errors.unknown'))
      else toast.show({ title: t('admin.backups.done'), tone: 'success' })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const verify = useMutation({
    mutationFn: (id: string) => http.post(`/admin/backups/${id}/verified`, { note: '' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEY })
      toast.show({ title: t('admin.backups.verified'), tone: 'success' })
    },
  })

  const reindex = useMutation({
    mutationFn: () => http.post('/admin/maintenance/reindex'),
    onSuccess: () => toast.show({ title: t('admin.maintenance.reindexStarted'), tone: 'success' }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!data) {
    return (
      <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
        <Skeleton className="h-40" />
      </div>
    )
  }

  const last = data.items.find((item) => item.status === 'done')

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-5">
      <Callout tone="info">{t('admin.backups.hint')}</Callout>

      <Card
        title={t('admin.backups.title')}
        action={
          <Button size="sm" variant="primary" loading={run.isPending} onClick={() => run.mutate()}>
            {t('admin.backups.run')}
          </Button>
        }
      >
        {last ? (
          <p className="text-xs text-fg-secondary">
            {t('admin.backups.last', {
              when: formatDateTime(last.startedAt, { locale }),
              size: formatFileSize(last.sizeBytes ?? 0, { locale }),
            })}
          </p>
        ) : (
          <p className="text-xs text-warning">{t('admin.backups.none')}</p>
        )}

        {data.items.length === 0 ? (
          <EmptyState compact icon={<Database />} title={t('admin.backups.empty')} />
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {data.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2 first:pt-0">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-fg">
                    {formatDateTime(item.startedAt, { locale })}
                  </span>
                  {item.error ? (
                    <span className="truncate text-2xs text-danger">{item.error}</span>
                  ) : item.verifiedAt ? (
                    <span className="text-2xs text-fg-muted">
                      {t('admin.backups.verifiedAt', {
                        when: formatDateTime(item.verifiedAt, { locale }),
                      })}
                    </span>
                  ) : null}
                </div>
                <span className="text-xs text-fg-secondary">
                  {item.sizeBytes ? formatFileSize(item.sizeBytes, { locale }) : '—'}
                </span>
                <Badge
                  size="sm"
                  tone={
                    item.status === 'done'
                      ? 'success'
                      : item.status === 'failed'
                        ? 'danger'
                        : 'accent'
                  }
                >
                  {t(`admin.backups.status.${item.status}`)}
                </Badge>
                {item.status === 'done' && !item.verifiedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => verify.mutate(item.id)}>
                    {t('admin.backups.markVerified')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('admin.maintenance.title')}>
        <p className="text-xs text-fg-secondary">{t('admin.maintenance.hint')}</p>
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            loading={reindex.isPending}
            onClick={() => reindex.mutate()}
          >
            {t('admin.maintenance.reindex')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
