import type { AlertCheckResult, AlertDefinition, MetricRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
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
import { AlertTriangle, PlayCircle, Save } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { alertEventsQuery, alertKeys, alertQuery, alertsApi } from './queries.js'

/**
 * Карточка алерта (ADR-0104): конструктор правила, «Проверить сейчас» и
 * тестовый прогон без рассылки, история срабатываний.
 */
export function AlertView({ objectId }: { objectId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const cronId = useId()
  const cooldownId = useId()
  const [draft, setDraft] = useState<AlertDefinition | null>(null)
  const [result, setResult] = useState<AlertCheckResult | null>(null)

  const { data: alert, isLoading, error, refetch } = useQuery(alertQuery(objectId))
  const definition = draft ?? alert?.definition ?? null
  const { data: metric } = useQuery({
    queryKey: ['alerts', 'metric', alert?.metricId],
    queryFn: () => http.get<MetricRecord>(`/metrics/${alert?.metricId}`),
    enabled: Boolean(alert?.metricId),
  })
  const { data: events } = useQuery(alertEventsQuery({ alertId: objectId, limit: 30 }))

  const save = useMutation({
    mutationFn: () => alertsApi.update(objectId, { definition: definition as AlertDefinition }),
    onSuccess: async () => {
      toast.success(t('alerts.designer.saved'))
      setDraft(null)
      await client.invalidateQueries({ queryKey: alertKeys.all })
    },
    onError: (error_) =>
      toast.error(error_ instanceof ApiError ? error_.message : t('errors.unknown')),
  })

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => alertsApi.setEnabled(objectId, enabled),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: alertKeys.all })
    },
    onError: (error_) =>
      toast.error(error_ instanceof ApiError ? error_.message : t('errors.unknown')),
  })

  const check = useMutation({
    mutationFn: (dryRun: boolean) => alertsApi.check(objectId, dryRun),
    onSuccess: async (next) => {
      setResult(next)
      if (!next.dryRun) await client.invalidateQueries({ queryKey: alertKeys.all })
    },
    onError: (error_) =>
      toast.error(error_ instanceof ApiError ? error_.message : t('errors.unknown')),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error || !alert || !definition) return <ErrorState onRetry={() => void refetch()} />

  const update = (next: Partial<AlertDefinition>) => setDraft({ ...definition, ...next })
  const condition = definition.condition
  const dimensions = metric?.definition.dimensions ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-canvas p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-fg">{alert.name}</h2>
        <Badge tone="neutral" size="sm">
          {alert.metricName ?? ''}
        </Badge>
        <Switch
          checked={alert.enabled}
          label={t('alerts.fields.enabled')}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
        />
        <div className="ml-auto flex flex-wrap gap-2">
          {/* Проверка идёт по сохранённому правилу: с несохранёнными правками она
              показала бы не то, что видит человек на экране */}
          <Button
            variant="secondary"
            disabled={draft !== null}
            loading={check.isPending && check.variables === true}
            icon={<PlayCircle className="size-4" />}
            onClick={() => check.mutate(true)}
          >
            {t('alerts.designer.dryRun')}
          </Button>
          <Button
            variant="secondary"
            disabled={draft !== null}
            loading={check.isPending && check.variables === false}
            onClick={() => check.mutate(false)}
          >
            {t('alerts.designer.checkNow')}
          </Button>
          <Button
            variant="primary"
            disabled={draft === null}
            loading={save.isPending}
            icon={<Save className="size-4" />}
            onClick={() => save.mutate()}
          >
            {t('common.actions.save')}
          </Button>
        </div>
      </div>

      <Card title={t('alerts.designer.condition')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('alerts.fields.condition')}>
            <Select
              value={condition.kind}
              onValueChange={(value) =>
                update({
                  condition:
                    value === 'threshold'
                      ? { kind: 'threshold', op: 'gt', value: 0 }
                      : value === 'change'
                        ? {
                            kind: 'change',
                            direction: 'any',
                            percent: 20,
                            comparison: 'previous_period',
                          }
                        : { kind: 'anomaly', z: 3, points: 30, seasonality: 'none' },
                })
              }
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

          {condition.kind === 'threshold' ? (
            <>
              <Field label={t('alerts.fields.op')}>
                <Select
                  value={condition.op}
                  onValueChange={(op) => update({ condition: { ...condition, op: op as 'gt' } })}
                >
                  <SelectTrigger aria-label={t('alerts.fields.op')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['gt', 'gte', 'lt', 'lte'] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`alerts.ops.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('alerts.fields.threshold')}>
                <Input
                  type="number"
                  value={String(condition.value)}
                  aria-label={t('alerts.fields.threshold')}
                  onChange={(event) =>
                    update({ condition: { ...condition, value: Number(event.target.value) || 0 } })
                  }
                />
              </Field>
            </>
          ) : null}

          {condition.kind === 'change' ? (
            <>
              <Field label={t('alerts.fields.direction')}>
                <Select
                  value={condition.direction}
                  onValueChange={(direction) =>
                    update({ condition: { ...condition, direction: direction as 'any' } })
                  }
                >
                  <SelectTrigger aria-label={t('alerts.fields.direction')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['any', 'up', 'down'] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`alerts.directions.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('alerts.fields.percent')}>
                <Input
                  type="number"
                  min={0}
                  value={String(condition.percent)}
                  aria-label={t('alerts.fields.percent')}
                  onChange={(event) =>
                    update({
                      condition: { ...condition, percent: Number(event.target.value) || 0 },
                    })
                  }
                />
              </Field>
            </>
          ) : null}

          {condition.kind === 'anomaly' ? (
            <>
              <Field label={t('alerts.fields.z')} hint={t('alerts.fields.zHint')}>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  step="0.5"
                  value={String(condition.z)}
                  aria-label={t('alerts.fields.z')}
                  onChange={(event) =>
                    update({ condition: { ...condition, z: Number(event.target.value) || 3 } })
                  }
                />
              </Field>
              <Field label={t('alerts.fields.seasonality')}>
                <Select
                  value={condition.seasonality}
                  onValueChange={(seasonality) =>
                    update({ condition: { ...condition, seasonality: seasonality as 'none' } })
                  }
                >
                  <SelectTrigger aria-label={t('alerts.fields.seasonality')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['none', 'weekly', 'monthly'] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`alerts.seasonality.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : null}
        </div>

        {dimensions.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <span className="text-xs text-fg-muted">{t('alerts.fields.dimensions')}</span>
            <div className="flex flex-wrap gap-3">
              {dimensions.map((field) => (
                <Checkbox
                  key={field}
                  checked={definition.dimensions.includes(field)}
                  label={field}
                  onCheckedChange={(next) =>
                    update({
                      dimensions:
                        next === true
                          ? [...definition.dimensions, field].slice(0, 2)
                          : definition.dimensions.filter((item) => item !== field),
                    })
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card title={t('alerts.designer.delivery')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('alerts.fields.cron')}
            htmlFor={cronId}
            hint={t('alerts.fields.cronHint')}
          >
            <Input
              id={cronId}
              value={definition.schedule.cron}
              mono
              onChange={(event) =>
                update({ schedule: { ...definition.schedule, cron: event.target.value } })
              }
            />
          </Field>
          <Field
            label={t('alerts.fields.cooldown')}
            htmlFor={cooldownId}
            hint={t('alerts.fields.cooldownHint')}
          >
            <Input
              id={cooldownId}
              type="number"
              min={0}
              value={String(definition.cooldownMinutes)}
              onChange={(event) => update({ cooldownMinutes: Number(event.target.value) || 0 })}
            />
          </Field>
          <Field label={t('alerts.fields.recipients')} hint={t('alerts.fields.recipientsHint')}>
            <Input
              value={definition.recipients.join(', ')}
              aria-label={t('alerts.fields.recipients')}
              placeholder="role:analyst, unit_head(...)"
              onChange={(event) =>
                update({
                  recipients: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-fg-muted">{t('alerts.fields.channels')}</span>
            <div className="flex flex-wrap gap-3">
              {(['notify', 'inbox', 'email'] as const).map((channel) => (
                <Checkbox
                  key={channel}
                  checked={definition.channels[channel]}
                  label={t(`alerts.channels.${channel}`)}
                  onCheckedChange={(next) =>
                    update({
                      channels: { ...definition.channels, [channel]: next === true },
                    })
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </Card>

      {result ? (
        <Card title={result.dryRun ? t('alerts.result.dryRun') : t('alerts.result.check')}>
          <Callout tone={result.fired > 0 ? 'warning' : 'info'}>
            {t('alerts.result.summary', { fired: result.fired, total: result.outcomes.length })}
          </Callout>
          <ul className="mt-3 flex flex-col gap-1.5">
            {result.outcomes.map((outcome) => (
              <li
                key={outcome.group.key || 'all'}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Badge tone={outcome.fired ? 'warning' : 'neutral'} size="sm">
                  {outcome.fired ? t('alerts.result.fired') : t('alerts.result.quiet')}
                </Badge>
                <span>{outcome.group.label || t('alerts.result.whole')}</span>
                <span className="tabular text-fg-secondary">{outcome.value ?? '—'}</span>
                {outcome.suppressed ? (
                  <Badge tone="neutral" size="sm">
                    {t('alerts.result.suppressed')}
                  </Badge>
                ) : null}
                {outcome.reason ? (
                  <span className="text-xs text-fg-muted">{outcome.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={t('alerts.history.title')}>
        {(events?.items ?? []).length === 0 ? (
          <EmptyState
            compact
            icon={<AlertTriangle className="size-5" />}
            title={t('alerts.history.empty')}
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(events?.items ?? []).map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs text-fg-muted">
                  {formatDateTime(item.firedAt, { locale })}
                </span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
