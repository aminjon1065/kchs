import type { ScheduleRecord } from '@kchs/contracts'
import { formatDateTime, formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, History, PlayCircle } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, automationKeys, scheduleRunsQuery, schedulesQuery } from './queries.js'

/**
 * «Расписания» в консоли (14-automation-integrations.md §2, ADR-0096):
 * регулярные проверки платформы и правила по cron — ближайший запуск,
 * последний результат, история и переключатель.
 */
export function SchedulesSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()
  const [historyKey, setHistoryKey] = useState<string | null>(null)
  const { data: items = [], isLoading } = useQuery(schedulesQuery())

  const invalidate = () => client.invalidateQueries({ queryKey: automationKeys.schedules })

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      automationApi.scheduleEnabled(key, enabled),
    onSuccess: async () => {
      toast.show({ title: t('schedules.toggled'), tone: 'success' })
      await invalidate()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const runNow = useMutation({
    mutationFn: (key: string) => automationApi.scheduleRun(key),
    onSuccess: async () => {
      toast.show({ title: t('schedules.started'), tone: 'success' })
      await invalidate()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const label = (row: ScheduleRecord) => (row.labelKey ? t(row.labelKey) : (row.title ?? row.job))

  const columns: Array<DataTableColumn<ScheduleRecord>> = [
    {
      key: 'name',
      header: t('schedules.columns.name'),
      width: 280,
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <Badge tone={row.kind === 'rule' ? 'accent' : 'neutral'}>
            {t(`schedules.kind.${row.kind}`)}
          </Badge>
          <span className="truncate">{label(row)}</span>
        </span>
      ),
    },
    {
      key: 'cron',
      header: t('schedules.columns.cron'),
      width: 150,
      cell: (row) => <code className="font-mono text-xs">{row.cron}</code>,
    },
    {
      key: 'next',
      header: t('schedules.columns.next'),
      width: 170,
      cell: (row) => (row.nextRunAt ? formatDateTime(row.nextRunAt, { locale }) : '—'),
    },
    {
      key: 'last',
      header: t('schedules.columns.last'),
      width: 190,
      cell: (row) =>
        row.lastRun ? (
          <span className="flex items-center gap-2 text-xs">
            <Badge tone={row.lastRun.status === 'failed' ? 'danger' : 'neutral'}>
              {row.lastRun.status}
            </Badge>
            {formatRelativeTime(row.lastRun.at, { locale })}
          </span>
        ) : (
          <span className="text-xs text-fg-secondary">{t('schedules.never')}</span>
        ),
    },
    {
      key: 'state',
      header: t('schedules.columns.state'),
      width: 90,
      cell: (row) => (
        <Switch
          checked={row.enabled}
          aria-label={row.enabled ? t('schedules.disable') : t('schedules.enable')}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(enabled) => toggle.mutate({ key: row.key, enabled })}
        />
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="max-w-2xl">
        <h2 className="text-base font-semibold text-fg">{t('schedules.title')}</h2>
        <p className="text-sm text-fg-secondary">{t('schedules.hint')}</p>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState icon={<CalendarClock className="size-5" />} title={t('schedules.empty')} />
      ) : (
        <div className="h-[30rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.key}
            columns={columns}
            rowActions={(row) => (
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => runNow.mutate(row.key)}
                  aria-label={t('schedules.runNow')}
                >
                  <PlayCircle className="size-4" />
                </Button>
                {row.kind === 'system' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHistoryKey(row.key)}
                    aria-label={t('schedules.history.open')}
                  >
                    <History className="size-4" />
                  </Button>
                ) : null}
              </span>
            )}
          />
        </div>
      )}

      <HistoryDialog scheduleKey={historyKey} onClose={() => setHistoryKey(null)} />
    </div>
  )
}

function HistoryDialog({
  scheduleKey,
  onClose,
}: {
  scheduleKey: string | null
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: runs = [], isLoading } = useQuery(scheduleRunsQuery(scheduleKey ?? ''))

  return (
    <Dialog open={scheduleKey !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent title={t('schedules.history.title')} size="md">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : runs.length === 0 ? (
          <EmptyState title={t('schedules.history.empty')} compact />
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-xs">
                <Badge tone={item.status === 'failed' ? 'danger' : 'neutral'}>{item.status}</Badge>
                <span className="text-fg-secondary">
                  {formatDateTime(item.finishedAt ?? item.createdAt, { locale })}
                </span>
                <span className="truncate text-fg-secondary">{item.message ?? item.error}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
