import type { RuleDefinition, RuleDryRunResult, RuleRunRecord } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { Badge, Button, Card, EmptyState, Input, Skeleton, useToast } from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { History, PlayCircle } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError } from '~/shared/api/client.js'
import { automationApi, ruleRunsQuery } from '../queries.js'

const TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'accent',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
}

/** История запусков правила с диагностикой шагов (ADR-0096). */
export function RunsPanel({ ruleId }: { ruleId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data, isLoading } = useQuery(ruleRunsQuery(ruleId))
  const items = data?.items ?? []

  if (isLoading) return <Skeleton className="h-40 w-full" />
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<History className="size-5" />}
        title={t('automation.runs.empty')}
        compact
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <RunCard key={item.id} run={item} locale={locale} />
      ))}
    </div>
  )
}

function RunCard({ run, locale }: { run: RuleRunRecord; locale: 'ru' | 'tg' | 'en' }) {
  const t = useT()
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[run.status] ?? 'neutral'}>
          {t(`automation.runs.status.${run.status}`)}
        </Badge>
        <span className="text-xs text-fg-secondary">
          {formatDateTime(run.startedAt ?? run.createdAt, { locale })}
        </span>
        {run.eventType ? <code className="font-mono text-xs">{run.eventType}</code> : null}
        {run.objectTitle ? (
          <span className="truncate text-xs text-fg-secondary">{run.objectTitle}</span>
        ) : null}
        {run.runAs ? (
          <span className="ms-auto text-xs text-fg-secondary">
            {t('automation.runs.runAs')}: {run.runAs.displayName}
          </span>
        ) : null}
      </div>
      {run.error ? <p className="text-xs text-danger">{run.error}</p> : null}
      {run.steps.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {run.steps.map((step) => (
            <li key={`${step.index}-${step.at}`} className="flex items-center gap-2 text-xs">
              <Badge
                size="sm"
                tone={
                  step.status === 'failed' ? 'danger' : step.status === 'ok' ? 'success' : 'neutral'
                }
              >
                {t(`automation.actions.${step.action}`)}
              </Badge>
              {step.branch === 'otherwise' ? (
                <Badge size="sm" tone="warning">
                  {t('automation.designer.otherwise')}
                </Badge>
              ) : null}
              <span className="truncate text-fg-secondary">{step.message}</span>
              <span className="ms-auto shrink-0 text-fg-tertiary">{step.durationMs} ms</span>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  )
}

/** Тестовый прогон: что бы произошло на последних событиях (ничего не делает). */
export function DryRunPanel({ definition }: { definition: RuleDefinition }) {
  const kind = definition.trigger.kind
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const [limit, setLimit] = useState(10)
  const [result, setResult] = useState<RuleDryRunResult | null>(null)

  const dryRun = useMutation({
    mutationFn: () => automationApi.dryRun(definition, limit),
    onSuccess: setResult,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-secondary">{t(`automation.dryRun.hints.${kind}`)}</p>
      <div className="flex items-end gap-2">
        {kind === 'schedule' || kind === 'metric' ? null : (
          <div className="w-28">
            <Input
              type="number"
              value={String(limit)}
              aria-label={t('automation.dryRun.limit')}
              onChange={(event) => setLimit(Math.max(1, Math.min(50, Number(event.target.value))))}
            />
          </div>
        )}
        <Button variant="secondary" loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
          <PlayCircle className="size-4" />
          {t('automation.dryRun.run')}
        </Button>
      </div>
      {result ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg">
            {t('automation.dryRun.result', { matched: result.matched, checked: result.checked })}
          </p>
          {result.items.length === 0 ? (
            <EmptyState title={t('automation.dryRun.empty')} compact />
          ) : (
            result.items.map((item) => (
              <Card key={item.eventId} className="flex flex-col gap-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={item.matched ? 'success' : 'neutral'}>
                    {item.matched ? t('automation.dryRun.matched') : t('automation.dryRun.skipped')}
                  </Badge>
                  {item.branch === 'otherwise' ? (
                    <Badge tone="warning">{t('automation.designer.otherwise')}</Badge>
                  ) : null}
                  <code className="font-mono text-xs">{item.eventType}</code>
                  <span className="text-xs text-fg-secondary">
                    {formatDateTime(item.occurredAt, { locale })}
                  </span>
                  {item.objectTitle ? (
                    <span className="truncate text-xs text-fg-secondary">{item.objectTitle}</span>
                  ) : null}
                </div>
                {item.reason ? (
                  <p className="text-xs text-fg-secondary">{item.reason}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {item.actions.map((action) => (
                      <li key={`${action.action}-${action.summary}`} className="text-xs text-fg">
                        {action.problem ? (
                          <span className="text-danger">{action.problem}</span>
                        ) : (
                          action.summary
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
