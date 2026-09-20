import type { AlertDefinition, AlertListItem } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'
import { alertKeys, alertsApi, alertsQuery } from './queries.js'

/**
 * Экран «Алерты» (06-analytics-engine.md §14, ADR-0104): правила на показатели
 * с включением проверки; конструктор — в карточке алерта.
 */
export function AlertsScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const client = useQueryClient()
  const toast = useToast()
  const [spaceId, setSpaceId] = useState('all')
  const [creating, setCreating] = useState(false)

  const { data, isLoading } = useQuery(alertsQuery(spaceId === 'all' ? {} : { spaceId }))
  const { data: spaces = [] } = useQuery(spacesQuery())

  const open = (alert: { id: string; name: string }) =>
    openTab({
      kind: 'object',
      objectId: alert.id,
      objectType: 'alert',
      title: alert.name,
      icon: 'alert',
      mode: 'permanent',
    })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      alertsApi.setEnabled(id, enabled),
    onSuccess: async (alert) => {
      toast.show({
        title: alert.enabled ? t('alerts.toggle.enabled') : t('alerts.toggle.disabled'),
        tone: 'success',
      })
      await client.invalidateQueries({ queryKey: alertKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const columns: Array<DataTableColumn<AlertListItem>> = [
    {
      key: 'name',
      header: t('alerts.columns.name'),
      width: 260,
      cell: (row) => <span className="truncate font-medium">{row.name}</span>,
    },
    {
      key: 'metric',
      header: t('alerts.columns.metric'),
      width: 220,
      cell: (row) => (
        <span className="truncate text-xs text-fg-secondary">{row.metricName ?? '—'}</span>
      ),
    },
    {
      key: 'condition',
      header: t('alerts.columns.condition'),
      width: 170,
      cell: (row) => <Badge tone="neutral">{t(`alerts.conditions.${row.conditionKind}`)}</Badge>,
    },
    {
      key: 'fired',
      header: t('alerts.columns.fired'),
      width: 150,
      cell: (row) =>
        row.lastFiredAt ? (
          <span className="flex items-center gap-1 text-xs">
            <span>{formatRelativeTime(row.lastFiredAt, { locale })}</span>
            {row.firedToday > 0 ? (
              <Badge tone="warning" size="sm">
                {row.firedToday}
              </Badge>
            ) : null}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'next',
      header: t('alerts.columns.next'),
      width: 150,
      cell: (row) => (row.nextRunAt ? formatRelativeTime(row.nextRunAt, { locale }) : '—'),
    },
    {
      key: 'state',
      header: t('alerts.columns.state'),
      width: 110,
      cell: (row) => (
        <Switch
          checked={row.enabled}
          aria-label={t('alerts.fields.enabled')}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(enabled) => toggle.mutate({ id: row.id, enabled })}
        />
      ),
    },
  ]

  const items = data?.items ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-canvas p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-fg">{t('alerts.title')}</h2>
          <p className="text-sm text-fg-secondary">{t('alerts.hint')}</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          {t('alerts.create')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={spaceId} onValueChange={setSpaceId}>
          <SelectTrigger aria-label={t('alerts.space')} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('alerts.allSpaces')}</SelectItem>
            {spaces.map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="size-5" />}
          title={t('alerts.empty.title')}
          description={t('alerts.empty.description')}
        />
      ) : (
        <div className="h-[28rem] min-h-0">
          <DataTable
            rows={items}
            getRowId={(row) => row.id}
            columns={columns}
            onRowClick={open}
            onRowOpen={open}
            aria-label={t('alerts.title')}
          />
        </div>
      )}

      <CreateAlertDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id, name) => {
          setCreating(false)
          open({ id, name })
        }}
      />
    </div>
  )
}

/** Новый алерт: название, пространство, показатель и вид условия. */
function CreateAlertDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string, name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [metricId, setMetricId] = useState('')
  const [kind, setKind] = useState<AlertDefinition['condition']['kind']>('threshold')

  const { data: spaces = [] } = useQuery(spacesQuery())
  const { data: metrics } = useQuery(objectListQuery({ type: 'metric', limit: 100 }))

  const create = useMutation({
    mutationFn: () => {
      const condition: AlertDefinition['condition'] =
        kind === 'threshold'
          ? { kind: 'threshold', op: 'gt', value: 0 }
          : kind === 'change'
            ? { kind: 'change', direction: 'any', percent: 20, comparison: 'previous_period' }
            : { kind: 'anomaly', z: 3, points: 30, seasonality: 'none' }
      const definition: AlertDefinition = {
        metricId,
        description: null,
        condition,
        dimensions: [],
        schedule: { cron: '0 9 * * *', timezone: 'Asia/Dushanbe' },
        recipients: [],
        channels: { notify: true, inbox: false, email: false },
        cooldownMinutes: 60,
      }
      return alertsApi.create({ name, spaceId, definition, enabled: false })
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: alertKeys.all })
      toast.show({ title: t('alerts.created'), tone: 'success' })
      onCreated(result.id, name)
      setName('')
      setMetricId('')
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('alerts.createTitle')}
        size="md"
        footer={
          <Button
            variant="primary"
            disabled={name.trim().length === 0 || spaceId.length === 0 || metricId.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('alerts.create')}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label={t('alerts.name')} htmlFor={nameId} required>
            <Input
              id={nameId}
              value={name}
              placeholder={t('alerts.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('alerts.space')} required>
            <Select value={spaceId} onValueChange={setSpaceId}>
              <SelectTrigger aria-label={t('alerts.space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {spaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('alerts.metric')} required>
            <Select value={metricId} onValueChange={setMetricId}>
              <SelectTrigger aria-label={t('alerts.metric')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(metrics?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('alerts.fields.condition')}>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as AlertDefinition['condition']['kind'])}
            >
              <SelectTrigger aria-label={t('alerts.fields.condition')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['threshold', 'change', 'anomaly'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`alerts.conditions.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
