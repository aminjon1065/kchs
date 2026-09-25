import {
  REPORT_DELIVERY_CHANNELS,
  REPORT_FORMATS,
  REPORT_SCHEDULE_FREQUENCIES,
  type ReportDeliveryChannel,
  type ReportFormat,
  type ReportParams,
  type ReportSchedule,
  type ReportScheduleFrequency,
  type ReportScheduleInput,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import { localizedText } from '@kchs/i18n'
import {
  AlertDialog,
  Avatar,
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { groupsQuery } from '~/features/admin/groups-section.js'
import { PERIOD_PRESETS, type PeriodPreset, periodValue } from '~/features/data/dashboard-layout.js'
import { UserPicker } from '~/features/tasks/user-picker.js'
import { ApiError, http } from '~/shared/api/client.js'
import { rolesQuery } from '~/shared/api/queries.js'
import { reportKeys, reportScheduleQuery } from './queries.js'

const AS_REPORT = '__report'
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

interface Recipient {
  id: string
  name: string
}

interface Draft extends Omit<ReportScheduleInput, 'recipients'> {
  recipients: Recipient[]
}

function draftOf(schedule: ReportSchedule | null, timezone: string): Draft {
  if (!schedule) {
    return {
      enabled: true,
      frequency: 'weekly',
      time: '08:00',
      weekdays: [1],
      monthDay: 1,
      cron: null,
      timezone,
      recipients: [],
      groups: [],
      roles: [],
      emails: [],
      channels: ['inbox'],
      formats: ['pdf'],
      params: null,
    }
  }
  const names = new Map(schedule.recipientRefs.map((ref) => [ref.id, ref.displayName]))
  return {
    enabled: schedule.enabled,
    frequency: schedule.frequency,
    time: schedule.time,
    weekdays: schedule.weekdays,
    monthDay: schedule.monthDay,
    cron: schedule.cron,
    timezone: schedule.timezone,
    recipients: schedule.recipients.map((id) => ({ id, name: names.get(id) ?? id })),
    groups: schedule.groups,
    roles: schedule.roles,
    emails: schedule.emails,
    channels: schedule.channels,
    formats: schedule.formats,
    params: schedule.params,
  }
}

/** Период рассылки: как в отчёте или предустановка (относительный — к дате запуска). */
function periodPresetOf(params: ReportParams | null): string {
  if (!params) return AS_REPORT
  const match = PERIOD_PRESETS.find(
    (preset) => JSON.stringify(periodValue(preset)) === JSON.stringify(params.period ?? null),
  )
  return match ?? AS_REPORT
}

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((item) => item !== value)
}

/**
 * Расписание и рассылка отчёта (P2-E05 S05, ADR-0078): период (ежедневно,
 * еженедельно, ежемесячно или cron) в часовом поясе, получатели-сотрудники,
 * каналы — Входящие, почта, Telegram. Каждый получатель получает свой рендер —
 * под своими правами.
 */
export function ReportScheduleDialog({
  reportId,
  open,
  onOpenChange,
  canManage,
  timezone,
}: {
  reportId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
  timezone: string
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const ids = { time: useId(), cron: useId(), tz: useId(), day: useId() }
  const { data: schedule, isLoading } = useQuery({
    ...reportScheduleQuery(reportId),
    enabled: open,
  })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setDraft(null)
      setFailure(null)
    } else if (!isLoading && draft === null) {
      setDraft(draftOf(schedule ?? null, timezone))
    }
  }, [open, isLoading, schedule, draft, timezone])

  const refresh = () => {
    void client.invalidateQueries({ queryKey: reportKeys.schedule(reportId) })
    void client.invalidateQueries({ queryKey: reportKeys.report(reportId) })
    void client.invalidateQueries({ queryKey: reportKeys.runs(reportId) })
  }
  const fail = (error: unknown) =>
    setFailure(error instanceof ApiError ? error.message : t('errors.unknown'))

  const save = useMutation({
    mutationFn: (value: Draft) =>
      http.put<ReportSchedule>(`/reports/${reportId}/schedule`, {
        ...value,
        recipients: value.recipients.map((recipient) => recipient.id),
      }),
    onSuccess: (saved) => {
      toast.show({ title: t('data.report.schedule.saved'), tone: 'success' })
      client.setQueryData(reportKeys.schedule(reportId), saved)
      refresh()
      onOpenChange(false)
    },
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: () => http.delete(`/reports/${reportId}/schedule`),
    onSuccess: () => {
      toast.show({ title: t('data.report.schedule.removed'), tone: 'info' })
      refresh()
      onOpenChange(false)
    },
    onError: fail,
  })
  const sendNow = useMutation({
    mutationFn: () =>
      http.post<{ runs: number; skipped: number }>(`/reports/${reportId}/schedule/run`),
    onSuccess: (result) => {
      toast.show({ title: t('data.report.schedule.sent', { count: result.runs }), tone: 'success' })
      refresh()
    },
    onError: fail,
  })

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current))
  const disabled = !canManage
  const valid =
    draft !== null &&
    draft.recipients.length + draft.groups.length + draft.roles.length + draft.emails.length > 0 &&
    draft.emails.every((email) => EMAIL.test(email)) &&
    draft.channels.length > 0 &&
    draft.formats.length > 0 &&
    (draft.frequency !== 'cron' || Boolean(draft.cron?.trim()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('data.report.schedule.title')}
        description={t('data.report.schedule.description')}
        size="lg"
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {schedule && canManage ? (
                <>
                  <Button
                    variant="secondary"
                    icon={<Send className="size-3.5" />}
                    loading={sendNow.isPending}
                    onClick={() => sendNow.mutate()}
                  >
                    {t('data.report.schedule.sendNow')}
                  </Button>
                  <Button variant="ghost" onClick={() => setRemoveOpen(true)}>
                    {t('data.report.schedule.remove')}
                  </Button>
                </>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                {t('common.actions.cancel')}
              </Button>
              {canManage ? (
                <Button
                  variant="primary"
                  disabled={!valid}
                  loading={save.isPending}
                  onClick={() => draft && save.mutate(draft)}
                >
                  {t('common.actions.save')}
                </Button>
              ) : null}
            </div>
          </div>
        }
      >
        {!draft ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
            <legend className="sr-only">{t('data.report.schedule.title')}</legend>
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            {!canManage ? (
              <Callout tone="info">{t('data.report.schedule.readOnly')}</Callout>
            ) : null}
            <Switch
              checked={draft.enabled}
              onCheckedChange={(next) => update({ enabled: next })}
              label={t('data.report.schedule.enabled')}
            />

            <Field label={t('data.report.schedule.frequency')}>
              <SegmentedControl<ReportScheduleFrequency>
                size="sm"
                aria-label={t('data.report.schedule.frequency')}
                value={draft.frequency}
                onValueChange={(next) => update({ frequency: next })}
                options={REPORT_SCHEDULE_FREQUENCIES.map((value) => ({
                  value,
                  label: t(`data.report.schedule.frequencies.${value}`),
                }))}
              />
            </Field>

            <div className="flex flex-wrap items-end gap-4">
              {draft.frequency === 'cron' ? (
                <Field
                  label={t('data.report.schedule.cron')}
                  hint={t('data.report.schedule.cronHint')}
                  htmlFor={ids.cron}
                  className="min-w-64 flex-1"
                >
                  <Input
                    id={ids.cron}
                    value={draft.cron ?? ''}
                    placeholder="0 8 * * 1"
                    onChange={(event) => update({ cron: event.target.value })}
                  />
                </Field>
              ) : (
                <Field label={t('data.report.schedule.time')} htmlFor={ids.time}>
                  <Input
                    id={ids.time}
                    type="time"
                    value={draft.time}
                    className="w-32"
                    onChange={(event) => update({ time: event.target.value || '08:00' })}
                  />
                </Field>
              )}
              {draft.frequency === 'monthly' ? (
                <Field label={t('data.report.schedule.monthDay')} htmlFor={ids.day}>
                  <Input
                    id={ids.day}
                    type="number"
                    min={1}
                    max={28}
                    value={String(draft.monthDay)}
                    className="w-24"
                    onChange={(event) =>
                      update({
                        monthDay: Math.min(
                          28,
                          Math.max(1, Math.round(Number(event.target.value) || 1)),
                        ),
                      })
                    }
                  />
                </Field>
              ) : null}
              <Field label={t('data.report.schedule.timezone')} htmlFor={ids.tz}>
                <Input
                  id={ids.tz}
                  value={draft.timezone}
                  className="w-48"
                  onChange={(event) => update({ timezone: event.target.value.trim() })}
                />
              </Field>
            </div>

            {draft.frequency === 'weekly' ? (
              <Field label={t('data.report.schedule.weekdaysLabel')}>
                <div className="flex flex-wrap gap-3">
                  {WEEKDAYS.map((day) => (
                    <Checkbox
                      key={day}
                      checked={draft.weekdays.includes(day)}
                      onCheckedChange={(next) => {
                        const weekdays = toggle(draft.weekdays, day, next === true)
                        if (weekdays.length > 0) update({ weekdays })
                      }}
                      label={t(`data.report.schedule.weekdays.${day}`)}
                    />
                  ))}
                </div>
              </Field>
            ) : null}

            <Field label={t('data.report.schedule.period')}>
              <Select
                value={periodPresetOf(draft.params)}
                onValueChange={(next) =>
                  update({
                    params:
                      next === AS_REPORT
                        ? null
                        : { period: periodValue(next as PeriodPreset), territory: null },
                  })
                }
              >
                <SelectTrigger aria-label={t('data.report.schedule.period')} className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AS_REPORT}>{t('data.report.schedule.asReport')}</SelectItem>
                  {PERIOD_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {t(`data.dashboard.periods.${preset}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={t('data.report.schedule.recipients')}>
              <div className="flex flex-col gap-2">
                {draft.recipients.length > 0 ? (
                  <ul
                    className="flex flex-wrap gap-2"
                    aria-label={t('data.report.schedule.recipients')}
                  >
                    {draft.recipients.map((recipient) => (
                      <li
                        key={recipient.id}
                        className="flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-xs"
                      >
                        <Avatar name={recipient.name} size="xs" />
                        <span>{recipient.name}</span>
                        {schedule?.recipientsWithoutAccess.includes(recipient.id) ? (
                          <span className="text-warning">{t('data.report.schedule.noAccess')}</span>
                        ) : null}
                        <IconButton
                          label={t('data.report.schedule.removeRecipient', {
                            name: recipient.name,
                          })}
                          size="sm"
                          onClick={() =>
                            update({
                              recipients: draft.recipients.filter(
                                (item) => item.id !== recipient.id,
                              ),
                            })
                          }
                        >
                          <X className="size-3" />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {canManage ? (
                  <UserPicker
                    value={null}
                    label={t('data.report.schedule.addRecipient')}
                    onChange={(user) => {
                      if (user && !draft.recipients.some((item) => item.id === user.id)) {
                        update({
                          recipients: [...draft.recipients, { id: user.id, name: user.title }],
                        })
                      }
                    }}
                  />
                ) : null}
                <p className="text-2xs text-fg-muted">{t('data.report.schedule.rights')}</p>
              </div>
            </Field>

            <RecipientGroups
              draft={draft}
              disabled={disabled}
              onChange={update}
              expanded={schedule?.expandedCount ?? 0}
              externalBlocked={schedule?.externalBlocked ?? false}
            />

            <div className="flex flex-wrap gap-8">
              <Field label={t('data.report.schedule.channels')}>
                <div className="flex flex-col gap-2">
                  {REPORT_DELIVERY_CHANNELS.map((channel) => (
                    <Checkbox
                      key={channel}
                      checked={draft.channels.includes(channel)}
                      onCheckedChange={(next) =>
                        update({
                          channels: toggle<ReportDeliveryChannel>(
                            draft.channels,
                            channel,
                            next === true,
                          ),
                        })
                      }
                      label={t(`data.report.channels.${channel}`)}
                    />
                  ))}
                </div>
              </Field>
              <Field label={t('data.report.schedule.formats')}>
                <div className="flex flex-col gap-2">
                  {REPORT_FORMATS.map((format) => (
                    <Checkbox
                      key={format}
                      checked={draft.formats.includes(format)}
                      onCheckedChange={(next) =>
                        update({
                          formats: toggle<ReportFormat>(draft.formats, format, next === true),
                        })
                      }
                      label={format.toUpperCase()}
                    />
                  ))}
                </div>
              </Field>
            </div>

            {schedule?.nextRunAt ? (
              <p className="text-xs text-fg-secondary">
                {t('data.report.schedule.next', {
                  date: formatDateTime(schedule.nextRunAt, { locale, timezone }),
                })}
              </p>
            ) : null}
          </fieldset>
        )}
        <AlertDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          title={t('data.report.schedule.removeConfirm')}
          description={t('data.report.schedule.removeHint')}
          confirmLabel={t('data.report.schedule.remove')}
          onConfirm={() => {
            setRemoveOpen(false)
            remove.mutate()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Простая проверка адреса: полную проверку делает сервер. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Группы, роли и внешние адреса рассылки (ADR-0164): группы и роли разворачиваются в
 * сотрудников на момент рассылки, внешним адресам уходит письмо с отчётом под правами
 * автора рассылки — кроме отчёта с грифом «Конфиденциально».
 */
function RecipientGroups({
  draft,
  disabled,
  onChange,
  expanded,
  externalBlocked,
}: {
  draft: Draft
  disabled: boolean
  onChange: (patch: Partial<Draft>) => void
  expanded: number
  externalBlocked: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: groups = [] } = useQuery(groupsQuery())
  const { data: roles = [] } = useQuery(rolesQuery())
  const [emails, setEmails] = useState(draft.emails.join('\n'))
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id
  const roleName = (key: string) => {
    const role = roles.find((item) => item.key === key)
    return role ? localizedText(role.name, locale) : key
  }
  const chips = (items: string[], label: (value: string) => string, key: 'groups' | 'roles') =>
    items.length > 0 ? (
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li
            key={item}
            className="flex items-center gap-1 rounded-sm border border-line bg-surface-2 py-0.5 pr-0.5 pl-2 text-xs"
          >
            {label(item)}
            {disabled ? null : (
              <IconButton
                size="sm"
                label={t('data.report.schedule.removeRecipient')}
                onClick={() => onChange({ [key]: items.filter((value) => value !== item) })}
              >
                <X className="size-3" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
    ) : null
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('data.report.schedule.groups')}>
          <div className="flex flex-col gap-2">
            {chips(draft.groups, groupName, 'groups')}
            {disabled ? null : (
              <Select
                value=""
                onValueChange={(id) =>
                  !draft.groups.includes(id) && onChange({ groups: [...draft.groups, id] })
                }
              >
                <SelectTrigger aria-label={t('data.report.schedule.addGroup')}>
                  <SelectValue placeholder={t('data.report.schedule.addGroup')} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </Field>
        <Field label={t('data.report.schedule.roles')}>
          <div className="flex flex-col gap-2">
            {chips(draft.roles, roleName, 'roles')}
            {disabled ? null : (
              <Select
                value=""
                onValueChange={(key) =>
                  !draft.roles.includes(key) && onChange({ roles: [...draft.roles, key] })
                }
              >
                <SelectTrigger aria-label={t('data.report.schedule.addRole')}>
                  <SelectValue placeholder={t('data.report.schedule.addRole')} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.key} value={role.key}>
                      {localizedText(role.name, locale)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </Field>
      </div>
      {expanded > 0 ? (
        <p className="text-2xs text-fg-muted">
          {t('data.report.schedule.expanded', { count: expanded })}
        </p>
      ) : null}
      <Field label={t('data.report.schedule.emails')} hint={t('data.report.schedule.emailsHint')}>
        <Textarea
          rows={2}
          value={emails}
          disabled={disabled}
          aria-label={t('data.report.schedule.emails')}
          onChange={(event) => setEmails(event.target.value)}
          onBlur={() =>
            onChange({
              emails: [
                ...new Set(
                  emails
                    .split(/[\s,;]+/)
                    .map((item) => item.trim().toLowerCase())
                    .filter(Boolean),
                ),
              ],
            })
          }
        />
      </Field>
      {draft.emails.some((email) => !EMAIL.test(email)) ? (
        <Callout tone="danger">{t('data.report.schedule.emailsInvalid')}</Callout>
      ) : null}
      {externalBlocked ? (
        <Callout tone="warning">{t('data.report.schedule.emailsBlocked')}</Callout>
      ) : null}
    </div>
  )
}
