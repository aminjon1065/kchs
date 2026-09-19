import { BUSINESS_DAY_KINDS, type BusinessDay, type BusinessDayKind } from '@kchs/contracts'
import { localizedText } from '@kchs/i18n'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatTile,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { businessYearQuery, calendarKeys } from '~/features/calendar/queries.js'
import { ApiError, http } from '~/shared/api/client.js'

const KIND_TONES: Record<BusinessDayKind, 'danger' | 'warning' | 'success' | 'neutral'> = {
  holiday: 'danger',
  weekend: 'warning',
  work: 'success',
  short: 'neutral',
}

const INTL: Record<string, string> = { ru: 'ru-RU', tg: 'tg-TJ', en: 'en-US' }

/** Рабочих дней в году: пн–пт по правилу недели с поправками производственного календаря. */
export function workingDaysIn(year: number, days: BusinessDay[]): number {
  const exceptions = new Map(days.map((item) => [item.day, item.kind]))
  let count = 0
  for (let time = Date.UTC(year, 0, 1); time < Date.UTC(year + 1, 0, 1); time += 86_400_000) {
    const date = new Date(time)
    const key = date.toISOString().slice(0, 10)
    const weekday = date.getUTCDay()
    const kind = exceptions.get(key)
    const working =
      kind === 'work' || kind === 'short'
        ? true
        : kind === 'holiday' || kind === 'weekend'
          ? false
          : weekday !== 0 && weekday !== 6
    if (working) count++
  }
  return count
}

/**
 * «Производственный календарь» (15-admin-operations.md «Система», ADR-0081):
 * праздники, перенесённые выходные, рабочие субботы и сокращённые дни года.
 * По нему считаются сроки «N рабочих дней», подбор времени и выходные в календаре.
 */
export function BusinessCalendarSection() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const [year, setYear] = useState(() => new Date().getFullYear())
  const [editing, setEditing] = useState<BusinessDay | 'new' | null>(null)
  const [removing, setRemoving] = useState<BusinessDay | null>(null)
  const { data, isLoading } = useQuery(businessYearQuery(year))
  const days = [...(data?.days ?? [])].sort((a, b) => a.day.localeCompare(b.day))
  const dateFormat = new Intl.DateTimeFormat(INTL[locale] ?? 'ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'short',
    timeZone: 'UTC',
  })

  const refresh = () => {
    void client.invalidateQueries({ queryKey: calendarKeys.businessYear(year) })
    void client.invalidateQueries({ queryKey: calendarKeys.all })
  }

  const remove = useMutation({
    mutationFn: (day: string) => http.delete(`/admin/business-calendar/${day}`),
    onSuccess: () => {
      toast.show({ title: t('admin.businessCalendar.removed'), tone: 'info' })
      setRemoving(null)
      refresh()
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const count = (kind: BusinessDayKind) => days.filter((item) => item.kind === kind).length

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <IconButton
            label={t('admin.businessCalendar.previousYear')}
            variant="secondary"
            size="sm"
            onClick={() => setYear(year - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </IconButton>
          <h2
            className="tabular min-w-16 text-center text-md font-semibold text-fg"
            aria-live="polite"
          >
            {year}
          </h2>
          <IconButton
            label={t('admin.businessCalendar.nextYear')}
            variant="secondary"
            size="sm"
            onClick={() => setYear(year + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </IconButton>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="size-3.5" />}
          onClick={() => setEditing('new')}
        >
          {t('admin.businessCalendar.add')}
        </Button>
      </div>
      <p className="text-sm text-fg-secondary">{t('admin.businessCalendar.hint')}</p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label={t('admin.businessCalendar.workingDays')}
          value={data ? workingDaysIn(year, days) : '—'}
        />
        <StatTile label={t('admin.businessCalendar.counts.holiday')} value={count('holiday')} />
        <StatTile label={t('admin.businessCalendar.counts.weekend')} value={count('weekend')} />
        <StatTile label={t('admin.businessCalendar.counts.work')} value={count('work')} />
      </div>

      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : days.length === 0 ? (
          <EmptyState compact icon={<CalendarDays />} title={t('admin.businessCalendar.empty')} />
        ) : (
          <ul
            className="divide-y divide-line"
            aria-label={t('admin.businessCalendar.listLabel', { year })}
          >
            {days.map((item) => (
              <li key={item.day} className="flex items-center gap-3 px-4 py-2">
                <span className="tabular w-40 shrink-0 text-sm text-fg">
                  {dateFormat.format(new Date(`${item.day}T00:00:00Z`))}
                </span>
                <Badge size="sm" tone={KIND_TONES[item.kind]}>
                  {t(`admin.businessCalendar.kinds.${item.kind}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
                  {item.note ? localizedText(item.note, locale) : ''}
                </span>
                <IconButton
                  size="sm"
                  label={t('admin.businessCalendar.edit', { day: item.day })}
                  onClick={() => setEditing(item)}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </IconButton>
                <IconButton
                  size="sm"
                  label={t('admin.businessCalendar.remove', { day: item.day })}
                  onClick={() => setRemoving(item)}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing ? (
        <BusinessDayDialog
          year={year}
          day={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('admin.businessCalendar.removeTitle')}
        description={t('admin.businessCalendar.removeHint')}
        confirmLabel={t('admin.businessCalendar.removeConfirm')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.day)
        }}
      />
    </div>
  )
}

function BusinessDayDialog({
  year,
  day,
  onClose,
  onSaved,
}: {
  year: number
  day: BusinessDay | null
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const toast = useToast()
  const ids = { date: useId(), ru: useId(), tg: useId(), en: useId() }
  const [date, setDate] = useState(day?.day ?? `${year}-01-01`)
  const [kind, setKind] = useState<BusinessDayKind>(day?.kind ?? 'holiday')
  const [note, setNote] = useState({
    ru: day?.note?.ru ?? '',
    tg: day?.note?.tg ?? '',
    en: day?.note?.en ?? '',
  })
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      http.put(`/admin/business-calendar/${date}`, {
        kind,
        note: note.ru.trim()
          ? {
              ru: note.ru.trim(),
              ...(note.tg.trim() ? { tg: note.tg.trim() } : {}),
              ...(note.en.trim() ? { en: note.en.trim() } : {}),
            }
          : null,
      }),
    onSuccess: () => {
      toast.show({ title: t('admin.businessCalendar.saved'), tone: 'success' })
      onSaved()
      onClose()
    },
    onError: (failure) =>
      setError(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={t(day ? 'admin.businessCalendar.editTitle' : 'admin.businessCalendar.addTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!date}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label={t('admin.businessCalendar.date')} htmlFor={ids.date} required>
            <Input
              id={ids.date}
              type="date"
              value={date}
              disabled={day !== null}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>
          <Field label={t('admin.businessCalendar.kind')}>
            <Select value={kind} onValueChange={(value) => setKind(value as BusinessDayKind)}>
              <SelectTrigger aria-label={t('admin.businessCalendar.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BUSINESS_DAY_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`admin.businessCalendar.kinds.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="-mt-1 text-xs text-fg-muted">
            {t(`admin.businessCalendar.kindHints.${kind}`)}
          </p>
          <Field label={t('admin.businessCalendar.noteRu')} htmlFor={ids.ru}>
            <Input
              id={ids.ru}
              value={note.ru}
              onChange={(event) => setNote({ ...note, ru: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.businessCalendar.noteTg')} htmlFor={ids.tg}>
              <Input
                id={ids.tg}
                value={note.tg}
                disabled={!note.ru.trim()}
                onChange={(event) => setNote({ ...note, tg: event.target.value })}
              />
            </Field>
            <Field label={t('admin.businessCalendar.noteEn')} htmlFor={ids.en}>
              <Input
                id={ids.en}
                value={note.en}
                disabled={!note.ru.trim()}
                onChange={(event) => setNote({ ...note, en: event.target.value })}
              />
            </Field>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
