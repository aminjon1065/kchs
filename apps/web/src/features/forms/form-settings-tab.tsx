import type { DatasetRecord, FormDefinition, FormRecord, FormSubject } from '@kchs/contracts'
import {
  Badge,
  Button,
  Card,
  Checkbox,
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
import { Save } from 'lucide-react'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { orgUnitsQuery } from '~/shared/api/queries.js'
import { formKeys, formsApi } from './queries.js'

/**
 * Настройка формы (ADR-0103): поля схемы — подмножество полей датасета,
 * скрытые авто-поля, периодичность и срок, назначения, приёмка и эскалация.
 */
const AUTO_ROLES = ['unit', 'period', 'author', 'submittedAt'] as const

export function FormSettingsTab({ form }: { form: FormRecord }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const timeId = useId()
  const dueId = useId()
  const [draft, setDraft] = useState<FormDefinition>(form.definition)

  const { data: dataset } = useQuery({
    queryKey: ['forms', 'dataset', form.datasetId],
    queryFn: () => http.get<DatasetRecord>(`/datasets/${form.datasetId}`),
  })
  const { data: units = [] } = useQuery(orgUnitsQuery())

  const save = useMutation({
    mutationFn: () => formsApi.update(form.id, { definition: draft }),
    onSuccess: async () => {
      toast.success(t('forms.settings.saved'))
      await client.invalidateQueries({ queryKey: formKeys.all })
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  if (!dataset) return <Skeleton className="h-64 w-full" />

  const selected = new Set(draft.fields.map((field) => field.key))
  const autoUsed = new Set(
    AUTO_ROLES.map((role) => draft.auto[role]).filter((key): key is string => Boolean(key)),
  )
  const available = dataset.fields.filter((field) => field.type !== 'geometry')

  const toggleField = (key: string, on: boolean) =>
    setDraft((current) => ({
      ...current,
      fields: on
        ? [...current.fields, { key, required: false, hint: null }]
        : current.fields.filter((field) => field.key !== key),
    }))

  const setRequired = (key: string, required: boolean) =>
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field) => (field.key === key ? { ...field, required } : field)),
    }))

  const setAuto = (role: (typeof AUTO_ROLES)[number], key: string) =>
    setDraft((current) => ({
      ...current,
      auto: { ...current.auto, [role]: key === 'none' ? null : key },
    }))

  const toggleUnit = (id: string, on: boolean) =>
    setDraft((current) => ({
      ...current,
      assignments: on
        ? ([...current.assignments, { kind: 'unit', id }] as FormSubject[])
        : current.assignments.filter((item) => !(item.kind === 'unit' && item.id === id)),
    }))

  const assignedUnits = new Set(
    draft.assignments.filter((item) => item.kind === 'unit').map((item) => item.id),
  )

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <Card title={t('forms.settings.fields')}>
        <ul className="flex flex-col gap-1.5">
          {available.map((field) => {
            const on = selected.has(field.key)
            const asAuto = autoUsed.has(field.key)
            const item = draft.fields.find((entry) => entry.key === field.key)
            return (
              <li key={field.key} className="flex flex-wrap items-center gap-3">
                <Checkbox
                  checked={on}
                  disabled={asAuto}
                  label={field.label.ru}
                  onCheckedChange={(next) => toggleField(field.key, next === true)}
                />
                <code className="font-mono text-2xs text-fg-muted">{field.key}</code>
                {asAuto ? (
                  <Badge tone="neutral" size="sm">
                    {t('forms.settings.autoField')}
                  </Badge>
                ) : null}
                {on ? (
                  <Checkbox
                    checked={item?.required ?? false}
                    label={t('forms.settings.required')}
                    onCheckedChange={(next) => setRequired(field.key, next === true)}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      </Card>

      <Card title={t('forms.settings.auto')}>
        <div className="grid gap-3 sm:grid-cols-2">
          {AUTO_ROLES.map((role) => (
            <Field key={role} label={t(`forms.settings.autoRoles.${role}`)}>
              <Select
                value={draft.auto[role] ?? 'none'}
                onValueChange={(key) => setAuto(role, key)}
              >
                <SelectTrigger aria-label={t(`forms.settings.autoRoles.${role}`)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('forms.settings.autoNone')}</SelectItem>
                  {available
                    .filter((field) => !selected.has(field.key))
                    .map((field) => (
                      <SelectItem key={field.key} value={field.key}>
                        {field.label.ru}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          ))}
        </div>
      </Card>

      <Card title={t('forms.settings.schedule')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('forms.fields.periodicity')}>
            <Select
              value={draft.schedule.periodicity}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  schedule: {
                    ...current.schedule,
                    periodicity: value as FormDefinition['schedule']['periodicity'],
                  },
                }))
              }
            >
              <SelectTrigger aria-label={t('forms.fields.periodicity')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['daily', 'weekly', 'monthly', 'once'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forms.periodicity.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('forms.settings.time')} htmlFor={timeId}>
            <Input
              id={timeId}
              type="time"
              value={draft.schedule.time}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  schedule: { ...current.schedule, time: event.target.value },
                }))
              }
            />
          </Field>
          {draft.schedule.periodicity === 'once' ? (
            <Field label={t('forms.settings.dueOn')} htmlFor={dueId}>
              <Input
                id={dueId}
                type="date"
                value={draft.schedule.dueOn ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: { ...current.schedule, dueOn: event.target.value || null },
                  }))
                }
              />
            </Field>
          ) : (
            <Field label={t('forms.settings.dueWorkingDays')} hint={t('forms.settings.dueHint')}>
              <Input
                type="number"
                min={0}
                max={30}
                value={String(draft.schedule.dueWorkingDays)}
                aria-label={t('forms.settings.dueWorkingDays')}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    schedule: {
                      ...current.schedule,
                      dueWorkingDays: Number(event.target.value) || 0,
                    },
                  }))
                }
              />
            </Field>
          )}
        </div>
      </Card>

      <Card title={t('forms.settings.assignments')}>
        <ul className="flex flex-col gap-1.5">
          {units.map((unit) => (
            <li key={unit.id}>
              <Checkbox
                checked={assignedUnits.has(unit.id)}
                label={unit.name.ru}
                onCheckedChange={(next) => toggleUnit(unit.id, next === true)}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('forms.settings.review')}>
        <div className="flex flex-col gap-3">
          <Switch
            checked={draft.review.enabled}
            label={t('forms.settings.reviewEnabled')}
            onCheckedChange={(enabled) =>
              setDraft((current) => ({ ...current, review: { ...current.review, enabled } }))
            }
          />
          <Field label={t('forms.settings.reviewers')} hint={t('forms.settings.reviewersHint')}>
            <Input
              value={draft.review.reviewers.join(', ')}
              aria-label={t('forms.settings.reviewers')}
              placeholder="unit_head(...), role:analyst"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  review: {
                    ...current.review,
                    reviewers: event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  },
                }))
              }
            />
          </Field>
          <Switch
            checked={draft.escalation.enabled}
            label={t('forms.settings.escalation')}
            onCheckedChange={(enabled) =>
              setDraft((current) => ({
                ...current,
                escalation: { ...current.escalation, enabled },
              }))
            }
          />
        </div>
      </Card>

      <div className="flex justify-end">
        <Button
          variant="primary"
          loading={save.isPending}
          icon={<Save className="size-4" />}
          onClick={() => save.mutate()}
        >
          {t('common.actions.save')}
        </Button>
      </div>
    </div>
  )
}
