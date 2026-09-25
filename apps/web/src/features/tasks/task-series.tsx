import type { TaskSeriesList, TaskSeriesRecord, TaskSeriesRule } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
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
  Switch,
  UserChip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Repeat } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { type PickedUser, UserPicker } from './user-picker.js'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface RepeatValue {
  enabled: boolean
  rule: TaskSeriesRule
  dueWorkingDays: string
  startsOn: string
  endsOn: string
}

const today = (): string => new Date().toISOString().slice(0, 10)

export function emptyRepeat(): RepeatValue {
  return {
    enabled: false,
    rule: { freq: 'weekly', interval: 1, weekdays: [1], monthDay: 1, time: '09:00' },
    dueWorkingDays: '1',
    startsOn: today(),
    endsOn: '',
  }
}

/** Правило заполнено: у еженедельного — хотя бы один день недели. */
export function repeatReady(value: RepeatValue): boolean {
  if (!value.enabled) return true
  if (value.rule.freq === 'weekly' && value.rule.weekdays.length === 0) return false
  return Number.parseInt(value.dueWorkingDays, 10) >= 1 && Boolean(value.startsOn)
}

/** Тело запроса серии — без шаблона, его собирает диалог создания. */
export function repeatFields(value: RepeatValue) {
  return {
    rule: value.rule,
    dueWorkingDays: Math.max(1, Number.parseInt(value.dueWorkingDays, 10) || 1),
    startsOn: value.startsOn,
    ...(value.endsOn ? { endsOn: value.endsOn } : {}),
  }
}

/** Правило словами: «По пн, пт в 09:00», «Каждые 2 дн. в 09:00». */
export function ruleText(rule: TaskSeriesRule, t: Translate): string {
  const at = t('tasks.series.at', { time: rule.time })
  if (rule.freq === 'daily') {
    const every =
      rule.interval === 1
        ? t('tasks.series.everyDay')
        : t('tasks.series.everyDays', { n: rule.interval })
    return `${every} ${at}`
  }
  if (rule.freq === 'weekly') {
    const days = [...rule.weekdays]
      .sort()
      .map((day) => t(`tasks.series.weekdays.d${day}`))
      .join(', ')
    const base =
      rule.interval === 1
        ? t('tasks.series.onDays', { days })
        : t('tasks.series.everyWeeks', { n: rule.interval, days })
    return `${base} ${at}`
  }
  const day =
    rule.monthDay === -1
      ? t('tasks.series.lastDay')
      : t('tasks.series.monthDayOf', { day: rule.monthDay })
  const base = rule.interval === 1 ? day : t('tasks.series.everyMonths', { n: rule.interval, day })
  return `${base} ${at}`
}

/**
 * Поля «Повторять» диалога создания (ADR-0156): частота, дни, время по часам
 * организации, срок каждого экземпляра в рабочих днях, начало и окончание серии.
 * При правке заведённой серии (`editing`) переключателя нет, а начало не меняется.
 */
export function RepeatFields({
  value,
  onChange,
  editing = false,
}: {
  value: RepeatValue
  onChange: (next: RepeatValue) => void
  editing?: boolean
}) {
  const t = useT()
  const id = useId()
  const set = (patch: Partial<RepeatValue>) => onChange({ ...value, ...patch })
  const setRule = (patch: Partial<TaskSeriesRule>) => set({ rule: { ...value.rule, ...patch } })
  const toggleDay = (day: number) =>
    setRule({
      weekdays: value.rule.weekdays.includes(day)
        ? value.rule.weekdays.filter((item) => item !== day)
        : [...value.rule.weekdays, day],
    })
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-3">
      {editing ? null : (
        <label className="flex items-center gap-2 text-sm text-fg" htmlFor={`${id}-repeat`}>
          <Switch
            id={`${id}-repeat`}
            checked={value.enabled}
            onCheckedChange={(checked) => set({ enabled: checked })}
          />
          {t('tasks.series.repeat')}
        </label>
      )}
      {value.enabled || editing ? (
        <>
          {editing ? null : <p className="text-xs text-fg-muted">{t('tasks.series.repeatHint')}</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('tasks.series.freq')}>
              <Select
                value={value.rule.freq}
                onValueChange={(freq) => setRule({ freq: freq as TaskSeriesRule['freq'] })}
              >
                <SelectTrigger aria-label={t('tasks.series.freq')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['daily', 'weekly', 'monthly'] as const).map((freq) => (
                    <SelectItem key={freq} value={freq}>
                      {t(`tasks.series.freqs.${freq}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={t(`tasks.series.intervals.${value.rule.freq}`)}
              htmlFor={`${id}-interval`}
            >
              <Input
                id={`${id}-interval`}
                type="number"
                min={1}
                max={12}
                value={String(value.rule.interval)}
                onChange={(event) =>
                  setRule({
                    interval: Math.min(
                      12,
                      Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                    ),
                  })
                }
              />
            </Field>
          </div>
          {value.rule.freq === 'weekly' ? (
            <Field label={t('tasks.series.weekdaysLabel')}>
              <div className="flex flex-wrap gap-1">
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <Button
                    key={day}
                    size="sm"
                    variant={value.rule.weekdays.includes(day) ? 'primary' : 'secondary'}
                    aria-pressed={value.rule.weekdays.includes(day)}
                    onClick={() => toggleDay(day)}
                  >
                    {t(`tasks.series.weekdays.d${day}`)}
                  </Button>
                ))}
              </div>
            </Field>
          ) : null}
          {value.rule.freq === 'monthly' ? (
            <Field label={t('tasks.series.monthDay')}>
              <Select
                value={String(value.rule.monthDay)}
                onValueChange={(day) => setRule({ monthDay: Number(day) })}
              >
                <SelectTrigger aria-label={t('tasks.series.monthDay')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {String(day)}
                    </SelectItem>
                  ))}
                  <SelectItem value="-1">{t('tasks.series.lastDay')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('tasks.series.time')} htmlFor={`${id}-time`}>
              <Input
                id={`${id}-time`}
                type="time"
                value={value.rule.time}
                onChange={(event) => setRule({ time: event.target.value || '09:00' })}
              />
            </Field>
            <Field
              label={t('tasks.series.dueDays')}
              hint={t('tasks.series.dueDaysHint')}
              htmlFor={`${id}-due`}
            >
              <Input
                id={`${id}-due`}
                type="number"
                min={1}
                max={366}
                value={value.dueWorkingDays}
                onChange={(event) => set({ dueWorkingDays: event.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {editing ? null : (
              <Field label={t('tasks.series.startsOn')} htmlFor={`${id}-starts`}>
                <Input
                  id={`${id}-starts`}
                  type="date"
                  value={value.startsOn}
                  onChange={(event) => set({ startsOn: event.target.value })}
                />
              </Field>
            )}
            <Field
              label={t('tasks.series.endsOn')}
              hint={t('tasks.series.endsOnHint')}
              htmlFor={`${id}-ends`}
            >
              <Input
                id={`${id}-ends`}
                type="date"
                value={value.endsOn}
                onChange={(event) => set({ endsOn: event.target.value })}
              />
            </Field>
          </div>
        </>
      ) : null}
    </div>
  )
}

const seriesKey = ['task-series'] as const

/** Серии повторяющихся поручений: правило, следующее, пауза и остановка (ADR-0156). */
export function SeriesDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const { data, isLoading } = useQuery({
    queryKey: seriesKey,
    queryFn: () => http.get<TaskSeriesList>('/task-series'),
  })
  const act = useMutation({
    mutationFn: (input: { id: string; action: 'pause' | 'resume' | 'stop' }) =>
      http.post<TaskSeriesRecord>(`/task-series/${input.id}/${input.action}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: seriesKey }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const items = data?.items ?? []
  const [editingId, setEditingId] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.series.title')}
        size="lg"
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        }
      >
        {!isLoading && items.length === 0 ? (
          <EmptyState
            compact
            icon={<Repeat />}
            title={t('tasks.series.empty')}
            description={t('tasks.series.emptyHint')}
          />
        ) : (
          <ul aria-label={t('tasks.series.title')} className="divide-y divide-line">
            {items.map((series) => (
              <li key={series.id} className="flex flex-col gap-1.5 py-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {series.title}
                  </span>
                  <Badge
                    size="sm"
                    tone={
                      series.status === 'active'
                        ? 'success'
                        : series.status === 'paused'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {t(`tasks.series.statuses.${series.status}`)}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-secondary">
                  <span>{ruleText(series.rule, t)}</span>
                  {series.assignee ? <UserChip user={series.assignee} /> : null}
                  <span>{t('tasks.series.createdCount', { count: series.createdCount })}</span>
                  {series.nextRunAt ? (
                    <span>
                      {t('tasks.series.next', {
                        date: formatDateTime(series.nextRunAt, { locale }),
                      })}
                    </span>
                  ) : null}
                </div>
                {series.statusReason ? (
                  <Callout tone="warning">{series.statusReason}</Callout>
                ) : null}
                {editingId === series.id ? (
                  <SeriesEditForm series={series} onDone={() => setEditingId(null)} />
                ) : series.can.edit ? (
                  <div className="flex gap-2">
                    {series.status === 'stopped' ? null : (
                      <Button size="sm" variant="secondary" onClick={() => setEditingId(series.id)}>
                        {t('tasks.series.edit')}
                      </Button>
                    )}
                    {series.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => act.mutate({ id: series.id, action: 'pause' })}
                      >
                        {t('tasks.series.pause')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => act.mutate({ id: series.id, action: 'resume' })}
                      >
                        {t('tasks.series.resume')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act.mutate({ id: series.id, action: 'stop' })}
                    >
                      {t('tasks.series.stop')}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Правка заведённой серии (ADR-0156): название, исполнитель, правило, срок и окончание —
 * для следующих поручений; уже созданные остаются как есть.
 */
function SeriesEditForm({ series, onDone }: { series: TaskSeriesRecord; onDone: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const id = useId()
  const instruction = series.kind === 'instruction'
  const [title, setTitle] = useState(series.title)
  const [assignee, setAssignee] = useState<PickedUser | null>(
    series.assignee ? { id: series.assignee.id, title: series.assignee.displayName } : null,
  )
  const [repeat, setRepeat] = useState<RepeatValue>({
    enabled: true,
    rule: series.rule,
    dueWorkingDays: String(series.dueWorkingDays),
    startsOn: series.startsOn,
    endsOn: series.endsOn ?? '',
  })
  const save = useMutation({
    mutationFn: () =>
      http.patch<TaskSeriesRecord>(`/task-series/${series.id}`, {
        title: title.trim(),
        assigneeId: assignee?.id ?? null,
        rule: repeat.rule,
        dueWorkingDays: Math.max(1, Number.parseInt(repeat.dueWorkingDays, 10) || 1),
        endsOn: repeat.endsOn || null,
      }),
    onSuccess: () => {
      toast.show({ title: t('tasks.series.saved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: seriesKey })
      onDone()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const ready =
    title.trim().length > 0 && repeatReady(repeat) && (!instruction || assignee !== null)

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-3">
      <p className="text-xs text-fg-muted">{t('tasks.series.editHint')}</p>
      <Field label={t('tasks.fields.title')} htmlFor={`${id}-title`} required>
        <Input
          id={`${id}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field label={t('tasks.fields.assignee')} required={instruction}>
        <UserPicker value={assignee} onChange={setAssignee} label={t('tasks.fields.assignee')} />
      </Field>
      <RepeatFields value={repeat} onChange={setRepeat} editing />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending}
          disabled={!ready}
          onClick={() => save.mutate()}
        >
          {t('tasks.series.save')}
        </Button>
      </div>
    </div>
  )
}
