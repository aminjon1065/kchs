import { WARNING_STATUSES, type WarningStatus, type WarningSummary } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, Plus, Rss, Siren } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { SEVERITY_TONE, STATUS_TONE } from './labels.js'
import {
  errorText,
  warningKeys,
  warningSettingsQuery,
  warningSourcesQuery,
  warningsApi,
  warningsQuery,
} from './queries.js'

/**
 * Экран «Предупреждения» (ADR-0202): реестр предупреждений CAP с состоянием и
 * строгостью, создание — вручную и из сообщения об опасном явлении, адреса
 * публичных лент для сайта и партнёров.
 */
export function WarningsScreen() {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [status, setStatus] = useState<'all' | WarningStatus>('all')
  const [picking, setPicking] = useState(false)

  const { data, isLoading } = useQuery(warningsQuery(status === 'all' ? {} : { status }))
  const { data: settings } = useQuery(warningSettingsQuery())

  const open = (warning: { id: string; title: string }) =>
    openTab({
      kind: 'object',
      objectId: warning.id,
      objectType: 'warning',
      title: warning.title,
      icon: 'warning',
      mode: 'permanent',
    })

  const created = async (id: string) => {
    await client.invalidateQueries({ queryKey: warningKeys.all })
    toast.show({ title: t('warnings.created'), tone: 'success' })
    open({ id, title: t('objects.types.warning') })
  }
  const failed = (error: unknown) => toast.error(errorText(error, t('errors.unknown')))

  const create = useMutation({
    mutationFn: () => warningsApi.create({}),
    onSuccess: (result) => created(result.id),
    onError: failed,
  })

  const columns: Array<DataTableColumn<WarningSummary>> = [
    {
      key: 'title',
      header: t('warnings.columns.title'),
      width: 320,
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {row.msgType !== 'Alert' ? (
            <Badge tone="purple" size="sm">
              {t(`warnings.msgType.${row.msgType}`)}
            </Badge>
          ) : null}
          {row.capStatus !== 'Actual' ? (
            <Badge tone="outline" size="sm">
              {t(`warnings.capStatus.${row.capStatus}`)}
            </Badge>
          ) : null}
          <span className="truncate font-medium">{row.title}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('warnings.columns.status'),
      width: 150,
      cell: (row) => (
        <Badge tone={STATUS_TONE[row.status]} size="sm" dot>
          {t(`warnings.status.${row.status}`)}
        </Badge>
      ),
    },
    {
      key: 'severity',
      header: t('warnings.columns.severity'),
      width: 140,
      cell: (row) => (
        <Badge tone={SEVERITY_TONE[row.severity]} size="sm">
          {t(`warnings.severity.${row.severity}`)}
        </Badge>
      ),
    },
    {
      key: 'areas',
      header: t('warnings.columns.areas'),
      width: 220,
      cell: (row) => (
        <span className="truncate text-xs text-fg-secondary">{row.areas.join(', ') || '—'}</span>
      ),
    },
    {
      key: 'published',
      header: t('warnings.columns.published'),
      width: 150,
      cell: (row) => (row.publishedAt ? formatDateTime(row.publishedAt, { locale }) : '—'),
    },
    {
      key: 'expires',
      header: t('warnings.columns.expires'),
      width: 150,
      cell: (row) => (row.expires ? formatDateTime(row.expires, { locale }) : '—'),
    },
  ]

  const items = data?.items ?? []
  const noSpace = settings ? settings.spaceId === null : false

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-canvas p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('warnings.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('warnings.hint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<FilePlus2 className="size-4" />}
            disabled={!settings?.sourceDatasetId}
            onClick={() => setPicking(true)}
          >
            {t('warnings.fromMessage')}
          </Button>
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            disabled={noSpace}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('warnings.create')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger aria-label={t('warnings.fields.status')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('warnings.filter.all')}</SelectItem>
            {WARNING_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`warnings.status.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {settings ? (
          <nav
            aria-label={t('warnings.feeds')}
            className="flex flex-wrap items-center gap-3 text-xs text-fg-secondary"
          >
            <Rss className="size-3.5" aria-hidden />
            <a className="text-accent hover:underline" href={settings.feeds.atom}>
              {t('warnings.feedAtom')}
            </a>
            {(['tg', 'ru', 'en'] as const).map((language) => (
              <a
                key={language}
                className="text-accent hover:underline"
                href={settings.feeds.rss[language]}
              >
                {`${t('warnings.feedRss')} · ${t(`warnings.languages.${language}`)}`}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
      {noSpace ? <p className="text-sm text-warning">{t('warnings.noSpace')}</p> : null}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Siren className="size-5" />}
          title={t('warnings.empty.title')}
          description={t('warnings.empty.description')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.id}
            columns={columns}
            onRowClick={open}
            onRowOpen={open}
            aria-label={t('warnings.title')}
          />
        </div>
      )}

      <SourcesDialog
        open={picking}
        onOpenChange={setPicking}
        onCreated={(id) => {
          setPicking(false)
          void created(id)
        }}
      />
    </div>
  )
}

/** Выбор сообщения об опасном явлении: последние строки реестра правами смотрящего. */
function SourcesDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const { data, isLoading } = useQuery(warningSourcesQuery(open))
  const create = useMutation({
    mutationFn: (rowId: string) => warningsApi.fromMessage(rowId),
    onSuccess: (result) => onCreated(result.id),
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  const items = data?.items ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('warnings.sources.title')} size="lg">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : items.length === 0 ? (
          <p className="text-sm text-fg-secondary">{t('warnings.sources.empty')}</p>
        ) : (
          <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
            {items.map((item) => (
              <li
                key={item.rowId}
                className="flex items-start gap-3 rounded-md border border-line bg-surface p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{item.title}</p>
                  <p className="text-xs text-fg-secondary">
                    {[
                      item.hazard,
                      item.territoryName,
                      item.occurredAt ? formatDateTime(item.occurredAt, { locale }) : null,
                      item.code,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {item.publishedAt ? (
                    <Badge tone="success" size="sm">
                      {`${t('warnings.sources.published')} · ${formatDateTime(item.publishedAt, { locale })}`}
                    </Badge>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={create.isPending && create.variables === item.rowId}
                  onClick={() => create.mutate(item.rowId)}
                >
                  {t('warnings.sources.pick')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
