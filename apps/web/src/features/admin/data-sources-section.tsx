import type {
  SourceColumn,
  SourceListItem,
  SourceMode,
  SourceQuery,
  SourceStatus,
} from '@kchs/contracts'
import { formatDateTime, formatNumber } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  Database,
  MoreHorizontal,
  Pencil,
  Play,
  Plug,
  Plus,
  Rss,
  Trash2,
} from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { FeedSourceDialog } from '~/features/data/sources/feed-dialog.js'
import {
  sourceApi,
  sourceKeys,
  sourceQuery,
  sourceRunsQuery,
  sourcesQuery,
  sourceTablesQuery,
} from '~/features/data/sources/queries.js'
import { ApiError } from '~/shared/api/client.js'
import { integrationsQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'

const STATUS_TONES: Record<SourceStatus, 'neutral' | 'accent' | 'success' | 'danger'> = {
  draft: 'neutral',
  queued: 'accent',
  running: 'accent',
  ok: 'success',
  error: 'danger',
}

/** Виды интеграций, которые годятся источником датасета. */
const DATABASE_KINDS = new Set(['postgres', 'mysql'])

function problemMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const field = Object.values(err.fieldErrors())[0]
  return field && !field.includes('.') ? `${err.message}: ${field}` : err.message
}

/**
 * «Источники данных» (14-automation-integrations.md §5, ADR-0107, ADR-0132):
 * датасеты из внешних баз и ленты по адресу. Подключение и секреты берутся из
 * интеграции, здесь — выборка или разбор ленты, режим, расписание и журнал.
 */
export function DataSourcesSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data, isLoading } = useQuery(sourcesQuery())
  const items = data?.items ?? []
  const [creating, setCreating] = useState(false)
  const [creatingFeed, setCreatingFeed] = useState(false)
  const [editing, setEditing] = useState<SourceListItem | null>(null)
  const [editingFeedId, setEditingFeedId] = useState('')
  const { data: editingFeed } = useQuery(sourceQuery(editingFeedId))
  const [removing, setRemoving] = useState<SourceListItem | null>(null)
  const [runsOf, setRunsOf] = useState<SourceListItem | null>(null)

  const refresh = () => void client.invalidateQueries({ queryKey: sourceKeys.all })
  const failed = (err: unknown) => toast.error(problemMessage(err, t('errors.unknown')))

  const check = useMutation({
    mutationFn: (id: string) => sourceApi.check(id),
    onSuccess: (result) => {
      toast.show({
        title: result.ok ? t('admin.dataSources.checkOk') : t('admin.dataSources.checkFailed'),
        description: result.message,
        tone: result.ok ? 'success' : 'danger',
      })
      refresh()
    },
    onError: failed,
  })

  const sync = useMutation({
    mutationFn: (id: string) => sourceApi.sync(id),
    onSuccess: () => {
      toast.show({ title: t('admin.dataSources.syncStarted'), tone: 'success' })
      refresh()
    },
    onError: failed,
  })

  const remove = useMutation({
    mutationFn: (id: string) => sourceApi.remove(id),
    onSuccess: () => {
      toast.show({ title: t('admin.dataSources.removed'), tone: 'info' })
      setRemoving(null)
      refresh()
    },
    onError: (err) => {
      setRemoving(null)
      failed(err)
    },
  })

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-secondary">{t('admin.dataSources.hint')}</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />}>
              {t('admin.dataSources.add')}
              <ChevronDown className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              icon={<Database className="size-4" />}
              onSelect={() => setCreating(true)}
            >
              {t('admin.dataSources.addDatabase')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Rss className="size-4" />}
              onSelect={() => setCreatingFeed(true)}
            >
              {t('admin.dataSources.feed.add')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Card padded={false}>
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState compact icon={<Database />} title={t('admin.dataSources.empty')} />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((source) => (
              <li key={source.id} className="flex items-start gap-3 px-4 py-3">
                {source.kind === 'feed' ? (
                  <Rss className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                ) : (
                  <Database className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{source.name}</span>
                    <Badge tone={STATUS_TONES[source.status]} size="sm" dot>
                      {t(`admin.dataSources.status.${source.status}`)}
                    </Badge>
                    <Badge tone="neutral" size="sm">
                      {source.kind === 'feed'
                        ? t('admin.dataSources.feed.kind')
                        : t(`admin.dataSources.modes.${source.mode}`)}
                    </Badge>
                    {source.enabled ? null : (
                      <Badge tone="neutral" size="sm">
                        {t('admin.dataSources.disabled')}
                      </Badge>
                    )}
                  </div>
                  <p className="tabular mt-1 text-xs text-fg-secondary">
                    {[
                      source.schedule
                        ? t('admin.dataSources.scheduleValue', { cron: source.schedule })
                        : t('admin.dataSources.manualOnly'),
                      source.rowCount === null
                        ? null
                        : t('admin.dataSources.rows', {
                            rows: formatNumber(source.rowCount, {}, { locale }),
                          }),
                      source.lastRunAt
                        ? t('admin.dataSources.lastRun', {
                            at: formatDateTime(source.lastRunAt, { locale }),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      size="sm"
                      label={t('admin.dataSources.actions', { name: source.name })}
                    >
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      icon={<Play className="size-4" />}
                      onSelect={() => sync.mutate(source.id)}
                    >
                      {t('admin.dataSources.sync')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<Plug className="size-4" />}
                      onSelect={() => check.mutate(source.id)}
                    >
                      {t('admin.dataSources.check')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<Pencil className="size-4" />}
                      onSelect={() =>
                        source.kind === 'feed' ? setEditingFeedId(source.id) : setEditing(source)
                      }
                    >
                      {t('admin.dataSources.settings')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setRunsOf(source)}>
                      {t('admin.dataSources.runs')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      danger
                      icon={<Trash2 className="size-4" />}
                      onSelect={() => setRemoving(source)}
                    >
                      {t('common.actions.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CreateSourceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          toast.show({ title: t('admin.dataSources.created'), tone: 'success' })
          refresh()
        }}
      />
      <FeedSourceDialog
        open={creatingFeed || (editingFeedId.length > 0 && editingFeed !== undefined)}
        source={editingFeedId ? (editingFeed ?? null) : null}
        onOpenChange={(open) => {
          if (open) return
          setCreatingFeed(false)
          setEditingFeedId('')
        }}
        onSaved={() => {
          toast.show({
            title: editingFeedId ? t('admin.dataSources.saved') : t('admin.dataSources.created'),
            tone: 'success',
          })
          if (editingFeedId) {
            void client.invalidateQueries({ queryKey: sourceKeys.one(editingFeedId) })
          }
          refresh()
        }}
      />
      <SourceSettingsDialog
        source={editing}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        onSaved={() => {
          toast.show({ title: t('admin.dataSources.saved'), tone: 'success' })
          refresh()
        }}
      />
      <RunsDialog source={runsOf} onOpenChange={(open) => (open ? undefined : setRunsOf(null))} />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => (next ? undefined : setRemoving(null))}
        title={t('admin.dataSources.removeTitle', { name: removing?.name ?? '' })}
        description={t('admin.dataSources.removeHint')}
        confirmLabel={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </div>
  )
}

/** Мастер источника: подключение → выборка → столбцы → режим и расписание. */
function CreateSourceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const t = useT()
  const formId = useId()
  const { data: integrations = [] } = useQuery(integrationsQuery())
  const { data: spaces = [] } = useQuery(spacesQuery())
  const connections = integrations.filter(
    (item) => DATABASE_KINDS.has(item.kind) && item.source === 'object',
  )
  const available = orderSpaces(spaces)

  const [integrationId, setIntegrationId] = useState('')
  const [spaceId, setSpaceId] = useState('')
  const [name, setName] = useState('')
  const [mode, setMode] = useState<SourceMode>('snapshot')
  const [kind, setKind] = useState<'table' | 'sql'>('table')
  const [schema, setSchema] = useState('public')
  const [table, setTable] = useState('')
  const [sql, setSql] = useState('')
  const [schedule, setSchedule] = useState('')
  const [cursorField, setCursorField] = useState('')
  const [columns, setColumns] = useState<SourceColumn[]>([])
  const [keyFields, setKeyFields] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const { data: tables } = useQuery(sourceTablesQuery(integrationId))
  const targetSpace = spaceId || available[0]?.id || ''
  const query = (): SourceQuery =>
    kind === 'sql' ? { kind: 'sql', sql } : { kind: 'table', schema, table }

  const preview = useMutation({
    mutationFn: () => sourceApi.preview({ integrationId, query: query(), limit: 20 }),
    onSuccess: (result) => {
      setColumns(result.columns)
      setError(null)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const create = useMutation({
    mutationFn: () =>
      sourceApi.create({
        name: name.trim(),
        spaceId: targetSpace,
        integrationId,
        query: query(),
        mode,
        columns,
        keyFields,
        enabled: true,
        ...(cursorField.trim() ? { cursorField: cursorField.trim() } : {}),
        ...(schedule.trim() ? { schedule: schedule.trim() } : {}),
      }),
    onSuccess: () => {
      onCreated()
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  const chosen = columns.filter((column) => Boolean(column.key))
  const valid =
    integrationId.length > 0 &&
    targetSpace.length > 0 &&
    name.trim().length > 0 &&
    chosen.length > 0 &&
    (mode !== 'incremental' || (cursorField.trim().length > 0 && keyFields.length > 0))

  const toggleColumn = (column: SourceColumn, checked: boolean) => {
    setColumns((list) =>
      list.map((item) =>
        item.name === column.name
          ? checked
            ? { ...item, key: item.key ?? column.name.toLowerCase() }
            : { ...item, key: undefined }
          : item,
      ),
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.dataSources.add')}
        description={t('admin.dataSources.addHint')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={!valid}
              loading={create.isPending}
            >
              {t('admin.dataSources.add')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) create.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {connections.length === 0 ? (
            <Callout tone="info">{t('admin.dataSources.noConnections')}</Callout>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={t('admin.dataSources.fields.integration')}
              htmlFor={`${formId}-conn`}
              required
            >
              <Select value={integrationId} onValueChange={setIntegrationId}>
                <SelectTrigger id={`${formId}-conn`}>
                  <SelectValue placeholder={t('admin.dataSources.fields.integrationPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('admin.dataSources.fields.space')} htmlFor={`${formId}-space`} required>
              <Select value={targetSpace} onValueChange={setSpaceId}>
                <SelectTrigger id={`${formId}-space`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {available.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label={t('admin.dataSources.fields.name')} htmlFor={`${formId}-name`} required>
            <Input
              id={`${formId}-name`}
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('admin.dataSources.fields.queryKind')} htmlFor={`${formId}-kind`}>
            <Select value={kind} onValueChange={(value) => setKind(value as 'table' | 'sql')}>
              <SelectTrigger id={`${formId}-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="table">{t('admin.dataSources.queryKinds.table')}</SelectItem>
                <SelectItem value="sql">{t('admin.dataSources.queryKinds.sql')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {kind === 'table' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('admin.dataSources.fields.schema')} htmlFor={`${formId}-schema`}>
                <Input
                  id={`${formId}-schema`}
                  className="font-mono"
                  value={schema}
                  onChange={(event) => setSchema(event.target.value)}
                />
              </Field>
              <Field
                label={t('admin.dataSources.fields.table')}
                htmlFor={`${formId}-table`}
                required
              >
                <Select value={table} onValueChange={setTable}>
                  <SelectTrigger id={`${formId}-table`}>
                    <SelectValue placeholder={t('admin.dataSources.fields.tablePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(tables?.items ?? []).map((item) => (
                      <SelectItem key={`${item.schema}.${item.table}`} value={item.table}>
                        {`${item.schema}.${item.table}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          ) : (
            <Field
              label={t('admin.dataSources.fields.sql')}
              htmlFor={`${formId}-sql`}
              hint={t('admin.dataSources.fields.sqlHint')}
              required
            >
              <Textarea
                id={`${formId}-sql`}
                className="font-mono"
                rows={4}
                value={sql}
                onChange={(event) => setSql(event.target.value)}
              />
            </Field>
          )}
          <div>
            <Button
              size="sm"
              variant="secondary"
              loading={preview.isPending}
              disabled={integrationId.length === 0 || (kind === 'table' ? !table : !sql.trim())}
              onClick={() => preview.mutate()}
            >
              {t('admin.dataSources.readColumns')}
            </Button>
          </div>
          {columns.length > 0 ? (
            <Card padded={false}>
              <ul className="max-h-56 divide-y divide-line overflow-y-auto">
                {columns.map((column) => (
                  <li key={column.name} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      label={column.name}
                      checked={Boolean(column.key)}
                      onCheckedChange={(checked) => toggleColumn(column, checked === true)}
                    />
                    <span className="ml-auto text-xs text-fg-muted">{column.type}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('admin.dataSources.fields.mode')} htmlFor={`${formId}-mode`}>
              <Select value={mode} onValueChange={(value) => setMode(value as SourceMode)}>
                <SelectTrigger id={`${formId}-mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="snapshot">{t('admin.dataSources.modes.snapshot')}</SelectItem>
                  <SelectItem value="incremental">
                    {t('admin.dataSources.modes.incremental')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={t('admin.dataSources.fields.schedule')}
              htmlFor={`${formId}-cron`}
              hint={t('admin.dataSources.fields.scheduleHint')}
            >
              <Input
                id={`${formId}-cron`}
                className="font-mono"
                placeholder="0 * * * *"
                value={schedule}
                onChange={(event) => setSchedule(event.target.value)}
              />
            </Field>
          </div>
          {mode === 'incremental' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={t('admin.dataSources.fields.cursorField')}
                htmlFor={`${formId}-cursor`}
                hint={t('admin.dataSources.fields.cursorHint')}
                required
              >
                <Input
                  id={`${formId}-cursor`}
                  className="font-mono"
                  value={cursorField}
                  onChange={(event) => setCursorField(event.target.value)}
                />
              </Field>
              <Field
                label={t('admin.dataSources.fields.keyFields')}
                htmlFor={`${formId}-key`}
                hint={t('admin.dataSources.fields.keyHint')}
                required
              >
                <Input
                  id={`${formId}-key`}
                  className="font-mono"
                  value={keyFields.join(', ')}
                  onChange={(event) =>
                    setKeyFields(
                      event.target.value
                        .split(',')
                        .map((part) => part.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </Field>
            </div>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Правка режима, расписания и включения. */
function SourceSettingsDialog({
  source,
  onOpenChange,
  onSaved,
}: {
  source: SourceListItem | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useT()
  const formId = useId()
  const [schedule, setSchedule] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [opened, setOpened] = useState<SourceListItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (source !== opened) {
    setOpened(source)
    setSchedule(source?.schedule ?? '')
    setEnabled(source?.enabled ?? true)
    setError(null)
  }

  const save = useMutation({
    mutationFn: () =>
      sourceApi.update(source?.id ?? '', { schedule: schedule.trim() || null, enabled }),
    onSuccess: () => {
      onSaved()
      onOpenChange(false)
    },
    onError: (err) => setError(problemMessage(err, t('errors.unknown'))),
  })

  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.dataSources.settingsTitle', { name: source?.name ?? '' })}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={save.isPending}>
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field
            label={t('admin.dataSources.fields.schedule')}
            htmlFor={`${formId}-cron`}
            hint={t('admin.dataSources.fields.scheduleHint')}
          >
            <Input
              id={`${formId}-cron`}
              className="font-mono"
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
            />
          </Field>
          <Checkbox
            label={t('admin.dataSources.fields.enabled')}
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Журнал синхронизаций источника: когда, сколько строк, что пошло не так. */
function RunsDialog({
  source,
  onOpenChange,
}: {
  source: SourceListItem | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data } = useQuery(sourceRunsQuery(source?.id ?? ''))
  const runs = data?.items ?? []

  return (
    <Dialog open={source !== null} onOpenChange={onOpenChange}>
      <DialogContent
        title={t('admin.dataSources.runsTitle', { name: source?.name ?? '' })}
        size="md"
      >
        {runs.length === 0 ? (
          <EmptyState compact icon={<Database />} title={t('admin.dataSources.runsEmpty')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    size="sm"
                    dot
                    tone={
                      run.status === 'succeeded'
                        ? 'success'
                        : run.status === 'failed'
                          ? 'danger'
                          : 'accent'
                    }
                  >
                    {t(`admin.dataSources.runStatus.${run.status}`)}
                  </Badge>
                  <span className="tabular text-xs text-fg-secondary">
                    {formatDateTime(run.startedAt, { locale })}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {t(`admin.dataSources.modes.${run.mode}`)}
                  </span>
                </div>
                {run.error ? (
                  <p className="mt-1 text-xs text-danger-fg">{run.error}</p>
                ) : (
                  <p className="tabular mt-1 text-xs text-fg-secondary">
                    {t('admin.dataSources.runStats', {
                      rows: String(run.stats.rows ?? 0),
                      inserted: String(run.stats.inserted ?? 0),
                      updated: String(run.stats.updated ?? 0),
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
