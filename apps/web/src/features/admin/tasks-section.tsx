import type { ControlMetricKey, ControlMetricsState, TaskSettings } from '@kchs/contracts'
import {
  Badge,
  Button,
  Card,
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
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { controlMetricsQuery, taskKeys, taskSettingsQuery } from '~/features/tasks/queries.js'
import { ApiError, http } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'

/** Подпись показателя контроля, пока он не заведён. */
const METRIC_LABEL: Record<ControlMetricKey, string> = {
  'instructions.overdue': 'tasks.settings.metricOverdue',
  'instructions.on_time_rate': 'tasks.settings.metricOnTimeRate',
}

/**
 * Настройки поручений установки (10-tasks-projects.md §4, ADR-0082): эскалация
 * просрочки руководителю исполнителя — включена ли и через сколько рабочих
 * дней после срока; показатели контроля исполнения. Правки попадают в аудит.
 */
export function TasksSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const daysId = useId()
  const { data } = useQuery(taskSettingsQuery())
  const [draft, setDraft] = useState<TaskSettings | null>(null)

  const save = useMutation({
    mutationFn: (next: TaskSettings) => http.put<TaskSettings>('/admin/tasks/settings', next),
    onSuccess: (saved) => {
      client.setQueryData(taskKeys.settings, saved)
      setDraft(null)
      toast.show({ title: t('tasks.settings.saved'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  const value = draft ?? data
  if (!value) {
    return (
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
        <Skeleton className="h-32" />
      </div>
    )
  }
  const escalation = value.escalation
  const update = (patch: Partial<TaskSettings['escalation']>) =>
    setDraft({ escalation: { ...escalation, ...patch } })

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-5">
      <Card title={t('tasks.settings.escalation')}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{t('tasks.settings.enabled')}</p>
              <p className="text-xs text-fg-secondary">{t('tasks.settings.escalationHint')}</p>
            </div>
            <Switch
              checked={escalation.enabled}
              onCheckedChange={(next) => update({ enabled: next })}
              aria-label={t('tasks.settings.enabled')}
            />
          </div>
          <Field
            label={t('tasks.settings.afterDays')}
            hint={t('tasks.settings.afterDaysHint')}
            htmlFor={daysId}
          >
            <Input
              id={daysId}
              type="number"
              min={0}
              max={10}
              className="w-32"
              disabled={!escalation.enabled}
              value={String(escalation.afterWorkingDays)}
              onChange={(event) =>
                update({
                  afterWorkingDays: Math.max(0, Math.min(10, Number(event.target.value) || 0)),
                })
              }
            />
          </Field>
          <div>
            <Button
              variant="primary"
              disabled={!draft}
              loading={save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        </div>
      </Card>
      <ControlMetricsCard />
    </div>
  )
}

/**
 * Показатели контроля исполнения: демо-данные заводят их сами, чистой
 * установке — кнопкой в выбранном пространстве (права — как у пространства).
 */
function ControlMetricsCard() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const spaceId = useId()
  const { data } = useQuery(controlMetricsQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())
  const [space, setSpace] = useState('')

  const setup = useMutation({
    mutationFn: () => http.post<ControlMetricsState>('/admin/tasks/metrics', { spaceId: space }),
    onSuccess: (state) => {
      client.setQueryData(taskKeys.metrics, state)
      void client.invalidateQueries({ queryKey: taskKeys.all })
      toast.show({ title: t('tasks.settings.metricsCreated'), tone: 'success' })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  if (!data) return <Skeleton className="h-32" />
  const missing = data.items.some((item) => item.id === null)
  return (
    <Card title={t('tasks.settings.metrics')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-secondary">{t('tasks.settings.metricsHint')}</p>
        <ul aria-label={t('tasks.settings.metrics')} className="divide-y divide-line">
          {data.items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-fg">
                {item.name ?? t(METRIC_LABEL[item.key])}
              </span>
              {item.id ? (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() =>
                    openTab({
                      kind: 'object',
                      objectId: item.id as string,
                      objectType: 'metric',
                      title: item.name ?? t(METRIC_LABEL[item.key]),
                      mode: 'permanent',
                    })
                  }
                >
                  {t('common.actions.open')}
                </Button>
              ) : (
                <Badge size="sm">{t('tasks.settings.metricMissing')}</Badge>
              )}
            </li>
          ))}
        </ul>
        {missing ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('tasks.settings.metricsSpace')} htmlFor={spaceId}>
              <Select value={space} onValueChange={setSpace}>
                <SelectTrigger id={spaceId} className="w-72">
                  <SelectValue placeholder={t('tasks.settings.metricsSpacePick')} />
                </SelectTrigger>
                <SelectContent>
                  {orderSpaces(spaces).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              variant="primary"
              disabled={!space}
              loading={setup.isPending}
              onClick={() => setup.mutate()}
            >
              {t('tasks.settings.metricsCreate')}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
