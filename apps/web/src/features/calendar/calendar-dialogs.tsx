import type {
  CalendarColor,
  CalendarFeedCreated,
  CalendarImportResult,
  CalendarRecord,
  CalendarSettings,
  Reminder,
  ResourceInfo,
} from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Button,
  Callout,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  FileDropzone,
  IconButton,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toneClasses,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarSearch, Copy, Link2, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { projectsQuery } from '~/features/tasks/queries.js'
import { ApiError, http } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { ColorInput, RemindersInput } from './event-editor.js'
import { calendarKeys, calendarSettingsQuery, calendarsQuery, feedsQuery } from './queries.js'
import { clockMinutes } from './time.js'

export type CreatableKind = 'team' | 'project' | 'resource' | 'subscription'

const RESOURCE_KINDS: ResourceInfo['kind'][] = ['room', 'equipment', 'vehicle', 'other']
const DURATIONS = [15, 30, 45, 60, 90, 120]
const FALLBACK_ZONES = ['Asia/Dushanbe', 'Asia/Tashkent', 'Asia/Almaty', 'Europe/Moscow', 'UTC']

function timeZones(current: string): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  const zones = supported ? supported('timeZone') : FALLBACK_ZONES
  return zones.includes(current) ? zones : [current, ...zones]
}

function useErrorText() {
  const t = useT()
  return (error: unknown) => (error instanceof ApiError ? error.message : t('errors.unknown'))
}

/**
 * Новый календарь: команды (пространство), проекта, ресурса (переговорная,
 * техника) или подписка на внешний ICS-канал.
 */
export function CreateCalendarDialog({
  kind,
  onClose,
}: {
  kind: CreatableKind
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const errorText = useErrorText()
  const ids = {
    title: useId(),
    url: useId(),
    location: useId(),
    capacity: useId(),
    description: useId(),
  }
  const [title, setTitle] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState<CalendarColor | null>(null)
  const [description, setDescription] = useState('')
  const [resourceKind, setResourceKind] = useState<ResourceInfo['kind']>('room')
  const [location, setLocation] = useState('')
  const [capacity, setCapacity] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const { data: spaces = [] } = useQuery({
    ...spacesQuery(),
    enabled: kind === 'team' || kind === 'resource',
  })
  const { data: projects = [] } = useQuery({ ...projectsQuery(), enabled: kind === 'project' })

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/calendars', {
        kind,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(color ? { color } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(kind === 'team' || kind === 'resource' ? { spaceId } : {}),
        ...(kind === 'project' ? { projectId } : {}),
        ...(kind === 'subscription' ? { url: url.trim() } : {}),
        ...(kind === 'resource'
          ? {
              resource: {
                kind: resourceKind,
                location: location.trim() || null,
                capacity: capacity ? Number(capacity) : null,
              },
            }
          : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      toast.show({ title: t('calendar.create.created'), tone: 'success' })
      onClose()
    },
    onError: (failure) => {
      if (failure instanceof ApiError) setFieldErrors(failure.fieldErrors())
      setError(errorText(failure))
    },
  })

  const valid =
    kind === 'subscription'
      ? url.trim().length > 0
      : kind === 'project'
        ? Boolean(projectId)
        : title.trim().length > 0 && Boolean(spaceId)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={t(`calendar.create.kinds.${kind}`)}
        description={t(`calendar.create.hints.${kind}`)}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {kind === 'subscription' ? (
            <Field
              label={t('calendar.create.url')}
              htmlFor={ids.url}
              error={fieldErrors.url}
              required
            >
              <Input
                id={ids.url}
                autoFocus
                inputMode="url"
                placeholder="https://…/calendar.ics"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
          ) : null}
          {kind === 'project' ? (
            <Field label={t('calendar.create.project')} error={fieldErrors.projectId} required>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger aria-label={t('calendar.create.project')}>
                  <SelectValue placeholder={t('calendar.create.chooseProject')} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.key} · {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {kind !== 'project' ? (
            <Field
              label={t('calendar.create.title')}
              htmlFor={ids.title}
              error={fieldErrors.title}
              required={kind !== 'subscription'}
            >
              <Input
                id={ids.title}
                autoFocus={kind !== 'subscription'}
                value={title}
                placeholder={
                  kind === 'resource' ? t('calendar.create.resourcePlaceholder') : undefined
                }
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
          ) : null}
          {kind === 'team' || kind === 'resource' ? (
            <Field label={t('calendar.create.space')} error={fieldErrors.spaceId} required>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger aria-label={t('calendar.create.space')}>
                  <SelectValue placeholder={t('calendar.create.chooseSpace')} />
                </SelectTrigger>
                <SelectContent>
                  {spaces
                    .filter((space) => space.kind !== 'personal')
                    .map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {space.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {kind === 'resource' ? (
            <>
              <Field label={t('calendar.resource.kind')}>
                <Select
                  value={resourceKind}
                  onValueChange={(value) => setResourceKind(value as ResourceInfo['kind'])}
                >
                  <SelectTrigger aria-label={t('calendar.resource.kind')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOURCE_KINDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`calendar.resource.kinds.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <Field label={t('calendar.resource.location')} htmlFor={ids.location}>
                  <Input
                    id={ids.location}
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                  />
                </Field>
                <Field label={t('calendar.resource.capacity')} htmlFor={ids.capacity}>
                  <Input
                    id={ids.capacity}
                    type="number"
                    min={1}
                    max={10000}
                    value={capacity}
                    onChange={(event) => setCapacity(event.target.value)}
                  />
                </Field>
              </div>
            </>
          ) : null}
          <Field label={t('calendar.create.color')}>
            <ColorInput value={color} onChange={setColor} />
          </Field>
          {kind === 'team' || kind === 'resource' ? (
            <Field label={t('calendar.create.description')} htmlFor={ids.description}>
              <Textarea
                id={ids.description}
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Найти календарь коллеги, подразделения или ресурса и добавить в свой список. */
export function AddCalendarDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const errorText = useErrorText()
  const [search, setSearch] = useState('')
  const query = useDebouncedValue(search.trim(), 250)
  const { data: settings } = useQuery(calendarSettingsQuery())
  const { data: found = [], isLoading } = useQuery(
    calendarsQuery({ scope: 'available', ...(query ? { q: query } : {}) }),
  )

  const add = useMutation({
    mutationFn: (calendar: CalendarRecord) =>
      http.put<CalendarSettings>('/calendar/settings', {
        addedCalendarIds: [...new Set([...(settings?.addedCalendarIds ?? []), calendar.id])],
        shown: { ...(settings?.shown ?? {}), [calendar.id]: true },
      }),
    onSuccess: (_, calendar) => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      toast.show({ title: t('calendar.add.added', { name: calendar.title }), tone: 'success' })
    },
    onError: (error) => toast.error(errorText(error)),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md" title={t('calendar.add.title')} description={t('calendar.add.hint')}>
        <div className="flex flex-col gap-3">
          <SearchInput
            autoFocus
            value={search}
            onValueChange={setSearch}
            placeholder={t('calendar.add.search')}
            aria-label={t('calendar.add.search')}
          />
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : found.length === 0 ? (
            <EmptyState compact icon={<CalendarSearch />} title={t('calendar.add.empty')} />
          ) : (
            <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
              {found.map((calendar) => (
                <li key={calendar.id} className="flex items-center gap-3 px-3 py-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2.5 shrink-0 rounded-full',
                      toneClasses(calendar.color).dot,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      {calendar.kind === 'personal' && calendar.owner
                        ? calendar.owner.displayName
                        : calendar.title}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {[t(`calendar.kinds.${calendar.kind}`), calendar.spaceName]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={add.isPending && add.variables?.id === calendar.id}
                    onClick={() => add.mutate(calendar)}
                  >
                    {t('calendar.add.action')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Название, цвет, пояс и описание календаря; у ресурса — вид, место, вместимость. */
export function CalendarSettingsDialog({
  calendar,
  onClose,
}: {
  calendar: CalendarRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const errorText = useErrorText()
  const ids = { title: useId(), description: useId(), location: useId(), capacity: useId() }
  const [title, setTitle] = useState(calendar.title)
  const [color, setColor] = useState<CalendarColor>(calendar.color)
  const [timezone, setTimezone] = useState(calendar.timezone)
  const [description, setDescription] = useState(calendar.description ?? '')
  const [resource, setResource] = useState<ResourceInfo | null>(calendar.resource)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      http.patch(`/calendars/${calendar.id}`, {
        ...(calendar.kind !== 'personal' && title.trim() ? { title: title.trim() } : {}),
        color,
        timezone,
        description: description.trim() || null,
        ...(resource ? { resource } : {}),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      void client.invalidateQueries({ queryKey: ['object', calendar.id] })
      toast.show({ title: t('calendar.settings.saved'), tone: 'success' })
      onClose()
    },
    onError: (failure) => setError(errorText(failure)),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="sm"
        title={t('calendar.settings.calendarTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {calendar.kind !== 'personal' ? (
            <Field label={t('calendar.create.title')} htmlFor={ids.title} required>
              <Input
                id={ids.title}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label={t('calendar.create.color')}>
            <ColorInput
              value={color}
              allowDefault={false}
              onChange={(next) => next && setColor(next)}
            />
          </Field>
          <Field label={t('calendar.settings.timezone')}>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger aria-label={t('calendar.settings.timezone')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeZones(timezone).map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {resource ? (
            <>
              <Field label={t('calendar.resource.kind')}>
                <Select
                  value={resource.kind}
                  onValueChange={(value) =>
                    setResource({ ...resource, kind: value as ResourceInfo['kind'] })
                  }
                >
                  <SelectTrigger aria-label={t('calendar.resource.kind')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOURCE_KINDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`calendar.resource.kinds.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <Field label={t('calendar.resource.location')} htmlFor={ids.location}>
                  <Input
                    id={ids.location}
                    value={resource.location ?? ''}
                    onChange={(event) =>
                      setResource({ ...resource, location: event.target.value || null })
                    }
                  />
                </Field>
                <Field label={t('calendar.resource.capacity')} htmlFor={ids.capacity}>
                  <Input
                    id={ids.capacity}
                    type="number"
                    min={1}
                    value={resource.capacity ?? ''}
                    onChange={(event) =>
                      setResource({
                        ...resource,
                        capacity: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  />
                </Field>
              </div>
            </>
          ) : null}
          <Field label={t('calendar.create.description')} htmlFor={ids.description}>
            <Textarea
              id={ids.description}
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Ссылки ICS-подписки на календарь: новая показывается один раз, её можно
 * отозвать. Лента строится с правами выпустившего — закрытые события «Занято».
 */
export function FeedDialog({
  calendar,
  onClose,
}: {
  calendar: CalendarRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const errorText = useErrorText()
  const locale = useAppearance((s) => s.locale)
  const urlId = useId()
  const [created, setCreated] = useState<string | null>(null)
  const { data: feeds = [], isLoading } = useQuery(feedsQuery(calendar.id))

  const create = useMutation({
    mutationFn: () => http.post<CalendarFeedCreated>(`/calendars/${calendar.id}/feeds`),
    onSuccess: (feed) => {
      setCreated(feed.url)
      void client.invalidateQueries({ queryKey: calendarKeys.feeds(calendar.id) })
    },
    onError: (error) => toast.error(errorText(error)),
  })
  const revoke = useMutation({
    mutationFn: (feedId: string) => http.delete(`/calendars/${calendar.id}/feeds/${feedId}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: calendarKeys.feeds(calendar.id) })
      toast.show({ title: t('calendar.feed.revoked'), tone: 'info' })
    },
    onError: (error) => toast.error(errorText(error)),
  })

  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created)
      toast.show({ title: t('calendar.feed.copied'), tone: 'success' })
    } catch {
      toast.error(t('calendar.feed.copyFailed'))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title={t('calendar.feed.title')}
        description={t('calendar.feed.hint')}
      >
        <div className="flex flex-col gap-3">
          {created ? (
            <Field
              label={t('calendar.feed.newLink')}
              htmlFor={urlId}
              hint={t('calendar.feed.once')}
            >
              <div className="flex gap-2">
                <Input
                  id={urlId}
                  readOnly
                  value={created}
                  onFocus={(event) => event.target.select()}
                />
                <IconButton label={t('calendar.feed.copy')} variant="secondary" onClick={copy}>
                  <Copy className="size-4" aria-hidden />
                </IconButton>
              </div>
            </Field>
          ) : null}
          {isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : feeds.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('calendar.feed.none')}</p>
          ) : (
            <ul
              aria-label={t('calendar.feed.list')}
              className="flex flex-col divide-y divide-line rounded-md border border-line"
            >
              {feeds.map((feed) => (
                <li key={feed.id} className="flex items-center gap-3 px-3 py-2">
                  <Link2 className="size-4 shrink-0 text-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block text-fg">
                      {t('calendar.feed.createdAt', {
                        date: formatDateTime(feed.createdAt, { locale }),
                      })}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {feed.lastUsedAt
                        ? t('calendar.feed.lastUsed', {
                            date: formatDateTime(feed.lastUsedAt, { locale }),
                          })
                        : t('calendar.feed.neverUsed')}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 className="size-3.5" />}
                    loading={revoke.isPending && revoke.variables === feed.id}
                    onClick={() => revoke.mutate(feed.id)}
                  >
                    {t('calendar.feed.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="secondary"
            className="self-start"
            icon={<Link2 className="size-4" />}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('calendar.feed.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Импорт файла `.ics`: события добавляются в календарь, повторный импорт обновляет их. */
export function ImportDialog({
  calendar,
  onClose,
}: {
  calendar: CalendarRecord
  onClose: () => void
}) {
  const t = useT()
  const client = useQueryClient()
  const errorText = useErrorText()
  const [result, setResult] = useState<CalendarImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: async (file: File) =>
      http.post<CalendarImportResult>(`/calendars/${calendar.id}/import`, {
        ics: await file.text(),
      }),
    onSuccess: (data) => {
      setResult(data)
      setError(null)
      void client.invalidateQueries({ queryKey: calendarKeys.all })
    },
    onError: (failure) => setError(errorText(failure)),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title={t('calendar.import.title', { name: calendar.title })}
        description={t('calendar.import.hint')}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <FileDropzone
            multiple={false}
            accept=".ics,text/calendar"
            disabled={upload.isPending}
            label={t('calendar.import.drop')}
            onFiles={(files) => files[0] && upload.mutate(files[0])}
          />
          {upload.isPending ? <Skeleton className="h-10 w-full" /> : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {result ? (
            <Callout tone={result.errors.length ? 'warning' : 'success'}>
              {t('calendar.import.result', {
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
              })}
              {result.errors.length ? (
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {result.errors.slice(0, 5).map((item, index) => (
                    // Ошибки разбора — без собственных ключей, список не меняется
                    <li key={index}>{item.uid ? `${item.uid}: ${item.message}` : item.message}</li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Мои настройки календаря: рабочие часы, длительность и напоминания по умолчанию. */
export function MySettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const errorText = useErrorText()
  const ids = { start: useId(), end: useId() }
  const { data: settings, isLoading } = useQuery(calendarSettingsQuery())
  const [draft, setDraft] = useState<{
    start: string
    end: string
    duration: number
    reminders: Reminder[]
  } | null>(null)
  const form = draft ?? {
    start: settings?.workingHours.start ?? '09:00',
    end: settings?.workingHours.end ?? '18:00',
    duration: settings?.defaultDurationMinutes ?? 60,
    reminders: settings?.defaultReminders ?? [],
  }
  const update = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch })
  const valid = clockMinutes(form.start) < clockMinutes(form.end)

  const save = useMutation({
    mutationFn: () =>
      http.put<CalendarSettings>('/calendar/settings', {
        workingHours: { start: form.start, end: form.end },
        defaultDurationMinutes: form.duration,
        defaultReminders: form.reminders,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      toast.show({ title: t('calendar.settings.saved'), tone: 'success' })
      onClose()
    },
    onError: (error) => toast.error(errorText(error)),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="md"
        title={t('calendar.settings.title')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!valid || isLoading}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label={t('calendar.settings.workStart')} htmlFor={ids.start}>
                <Input
                  id={ids.start}
                  type="time"
                  value={form.start}
                  onChange={(event) => event.target.value && update({ start: event.target.value })}
                />
              </Field>
              <Field
                label={t('calendar.settings.workEnd')}
                htmlFor={ids.end}
                error={valid ? undefined : t('calendar.settings.workHoursInvalid')}
              >
                <Input
                  id={ids.end}
                  type="time"
                  value={form.end}
                  onChange={(event) => event.target.value && update({ end: event.target.value })}
                />
              </Field>
              <Field label={t('calendar.settings.duration')}>
                <Select
                  value={String(form.duration)}
                  onValueChange={(value) => update({ duration: Number(value) })}
                >
                  <SelectTrigger aria-label={t('calendar.settings.duration')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {t('calendar.findTime.minutes', { count: minutes })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <p className="-mt-2 text-xs text-fg-muted">{t('calendar.settings.workHoursHint')}</p>
            <Field label={t('calendar.settings.reminders')}>
              <RemindersInput
                value={form.reminders}
                onChange={(reminders) => update({ reminders })}
              />
            </Field>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
