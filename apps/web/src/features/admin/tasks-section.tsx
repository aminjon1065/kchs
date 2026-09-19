import type { TaskSettings } from '@kchs/contracts'
import { Button, Card, Field, Input, Skeleton, Switch, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { taskKeys, taskSettingsQuery } from '~/features/tasks/queries.js'
import { ApiError, http } from '~/shared/api/client.js'

/**
 * Настройки поручений установки (10-tasks-projects.md §4, ADR-0082): эскалация
 * просрочки руководителю исполнителя — включена ли и через сколько рабочих дней
 * после срока. Правка попадает в аудит.
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
    </div>
  )
}
