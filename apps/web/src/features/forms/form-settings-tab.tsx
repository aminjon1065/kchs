import type { DatasetRecord, FormAssignment, FormDefinition, FormRecord } from '@kchs/contracts'
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
import { UserPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { orgUnitsQuery, principalRefsQuery } from '~/shared/api/queries.js'
import { formKeys, formsApi } from './queries.js'

/**
 * Настройка формы (ADR-0103, ADR-0129): вид (одна запись или таблица), поля
 * схемы — подмножество полей датасета, скрытые авто-поля, периодичность и
 * срок (рабочими или календарными днями), назначения с ответственным за сдачу,
 * приёмка и эскалация.
 */
const AUTO_ROLES = ['unit', 'period', 'author', 'submittedAt'] as const

/** Как на сервере (ADR-0103): вычисляемые и особые типы форма не спрашивает. */
const NOT_ASKABLE = new Set(['formula', 'lookup', 'rollup', 'geometry', 'file', 'signature'])

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
  const available = dataset.fields.filter((field) => !NOT_ASKABLE.has(field.type))

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
        ? ([
            ...current.assignments,
            { kind: 'unit', id, responsibleId: null },
          ] satisfies FormAssignment[])
        : current.assignments.filter((item) => !(item.kind === 'unit' && item.id === id)),
    }))

  const setResponsible = (unitId: string, responsibleId: string | null) =>
    setDraft((current) => ({
      ...current,
      assignments: current.assignments.map((item) =>
        item.kind === 'unit' && item.id === unitId ? { ...item, responsibleId } : item,
      ),
    }))

  const assignedUnits = new Map(
    draft.assignments
      .filter((item) => item.kind === 'unit')
      .map((item) => [item.id, item.responsibleId ?? null]),
  )
  const calendarDays = draft.schedule.dueMode === 'calendar'

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
      <Card title={t('forms.settings.layout')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('forms.settings.layoutKind')} hint={t('forms.settings.layoutHint')}>
            <Select
              value={draft.layout}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, layout: value as FormDefinition['layout'] }))
              }
            >
              <SelectTrigger aria-label={t('forms.settings.layoutKind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['single', 'table'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forms.layouts.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.layout === 'table' ? (
            <>
              <Field label={t('forms.settings.minRows')} hint={t('forms.settings.minRowsHint')}>
                <Input
                  type="number"
                  min={0}
                  max={500}
                  value={String(draft.table.minRows)}
                  aria-label={t('forms.settings.minRows')}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      table: { ...current.table, minRows: Number(event.target.value) || 0 },
                    }))
                  }
                />
              </Field>
              <Field label={t('forms.settings.maxRows')}>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={String(draft.table.maxRows)}
                  aria-label={t('forms.settings.maxRows')}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      table: { ...current.table, maxRows: Number(event.target.value) || 1 },
                    }))
                  }
                />
              </Field>
            </>
          ) : null}
        </div>
      </Card>

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
          <Field label={t('forms.settings.dueMode')} hint={t('forms.settings.dueModeHint')}>
            <Select
              value={draft.schedule.dueMode}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  schedule: {
                    ...current.schedule,
                    dueMode: value as FormDefinition['schedule']['dueMode'],
                  },
                }))
              }
            >
              <SelectTrigger aria-label={t('forms.settings.dueMode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['working', 'calendar'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`forms.dueModes.${value}`)}
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
            <Field
              label={
                calendarDays
                  ? t('forms.settings.dueCalendarDays')
                  : t('forms.settings.dueWorkingDays')
              }
              hint={
                calendarDays ? t('forms.settings.dueCalendarHint') : t('forms.settings.dueHint')
              }
            >
              <Input
                type="number"
                min={0}
                max={30}
                value={String(draft.schedule.dueWorkingDays)}
                aria-label={
                  calendarDays
                    ? t('forms.settings.dueCalendarDays')
                    : t('forms.settings.dueWorkingDays')
                }
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
        <p className="mb-2 text-xs text-fg-muted">{t('forms.settings.responsibleHint')}</p>
        <ul className="flex flex-col gap-1.5">
          {units.map((unit) => {
            const assigned = assignedUnits.has(unit.id)
            return (
              <li key={unit.id} className="flex flex-col gap-1.5">
                <Checkbox
                  checked={assigned}
                  label={unit.name.ru}
                  onCheckedChange={(next) => toggleUnit(unit.id, next === true)}
                />
                {assigned ? (
                  <ResponsibleField
                    unitName={unit.name.ru}
                    value={assignedUnits.get(unit.id) ?? null}
                    onChange={(responsibleId) => setResponsible(unit.id, responsibleId)}
                  />
                ) : null}
              </li>
            )
          })}
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
          {draft.escalation.enabled ? (
            <Field
              label={t('forms.settings.escalationDays')}
              hint={
                calendarDays
                  ? t('forms.settings.escalationCalendarHint')
                  : t('forms.settings.escalationHint')
              }
              className="max-w-xs"
            >
              <Input
                type="number"
                min={0}
                max={30}
                value={String(draft.escalation.afterWorkingDays)}
                aria-label={t('forms.settings.escalationDays')}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    escalation: {
                      ...current.escalation,
                      afterWorkingDays: Number(event.target.value) || 0,
                    },
                  }))
                }
              />
            </Field>
          ) : null}
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

/**
 * Ответственный за сдачу назначенного подразделения (ADR-0129): ему уходит дело
 * «Сдать сводку»; пусто — глава подразделения, а без главы — его сотрудники.
 */
function ResponsibleField({
  unitName,
  value,
  onChange,
}: {
  unitName: string
  value: string | null
  onChange: (responsibleId: string | null) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const key = `user:${value ?? ''}`
  const { data: refs } = useQuery(principalRefsQuery(value ? [key] : []))
  const person = value ? refs?.get(key) : undefined

  if (editing) {
    return (
      <div className="ml-6 flex max-w-md flex-col gap-1.5">
        <UserPicker
          value={null}
          label={t('forms.settings.responsibleFor', { unit: unitName })}
          onChange={(user) => {
            if (user) onChange(user.id)
            setEditing(false)
          }}
        />
        <Button variant="link" size="sm" className="self-start" onClick={() => setEditing(false)}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    )
  }
  return (
    <div className="ml-6 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
      <span>
        {value
          ? t('forms.settings.responsible', { name: person?.title ?? '' })
          : t('forms.settings.responsibleDefault')}
      </span>
      <Button variant="link" size="sm" onClick={() => setEditing(true)}>
        {value ? t('forms.settings.responsibleChange') : t('forms.settings.responsibleSet')}
      </Button>
      {value ? (
        <Button variant="link" size="sm" onClick={() => onChange(null)}>
          {t('forms.settings.responsibleReset')}
        </Button>
      ) : null}
    </div>
  )
}
