import type { DatasetField, DatasetRecord, ImportRecord, Locale } from '@kchs/contracts'
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelativeTime,
} from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  type BadgeProps,
  Button,
  Callout,
  Card,
  cn,
  EmptyState,
  Histogram,
  IconButton,
  InlineEdit,
  KeyValueList,
  ObjectIcon,
  PanelToolbar,
  ProgressBar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { History, Share2, Trash2, Upload } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { ImportWizard } from './import-wizard.js'
import {
  dataKeys,
  datasetImportsQuery,
  datasetQuery,
  datasetVersionsQuery,
  fieldProfileQuery,
} from './queries.js'

const IMPORT_TONES: Record<ImportRecord['status'], BadgeProps['tone']> = {
  queued: 'neutral',
  normalizing: 'accent',
  loading: 'accent',
  succeeded: 'success',
  failed: 'danger',
}

/**
 * Экран датасета (03-screens.md §5): шапка с версией и числом строк, вкладки
 * «Схема», «Версии», «Импорты». Таблица строк подключается с DataGrid.
 */
export function DatasetView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)

  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: dataset, isLoading } = useQuery(datasetQuery(objectId))

  const rename = useMutation({
    mutationFn: (title: string) => http.patch(`/objects/${objectId}`, { title }),
    onSuccess: (_result, title) => {
      setTabTitle(tabId, title)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: dataKeys.dataset(objectId) })
    },
  })

  const trash = useMutation({
    mutationFn: () => http.delete(`/objects/${objectId}`),
    onSuccess: () => {
      toast.show({
        title: t('objects.trash.movedTo'),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => void http.post(`/objects/${objectId}/restore`),
        },
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      closeTab(tabId)
    },
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (!dataset) return <EmptyState title={t('common.states.notFound')} />

  const level = object?.level ?? 'view'
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="dataset" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={dataset.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            <Badge size="sm">v{dataset.currentVersion}</Badge>
            <span className="truncate text-xs text-fg-secondary">
              {t('data.dataset.rows', { count: dataset.rowCount })}
              {dataset.lastImportAt
                ? ` · ${t('data.dataset.lastImport', {
                    when: formatRelativeTime(dataset.lastImportAt, { locale }),
                  })}`
                : ''}
            </span>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Upload className="size-3.5" />}
                onClick={() => setImportOpen(true)}
              >
                {t('data.dataset.import')}
              </Button>
            ) : null}
            <IconButton label={t('common.actions.share')} onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" />
            </IconButton>
            {canManage ? (
              <IconButton
                label={t('common.actions.delete')}
                variant="danger"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" />
              </IconButton>
            ) : null}
          </>
        }
      />

      <Tabs defaultValue="schema" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="schema" count={dataset.fields.length}>
            {t('data.dataset.tabs.schema')}
          </TabsTrigger>
          <TabsTrigger value="versions">{t('data.dataset.tabs.versions')}</TabsTrigger>
          <TabsTrigger value="imports">{t('data.dataset.tabs.imports')}</TabsTrigger>
        </TabsList>

        <TabsContent value="schema" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <SchemaTab dataset={dataset} />
        </TabsContent>
        <TabsContent value="versions" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <VersionsTab datasetId={objectId} current={dataset.currentVersion} />
        </TabsContent>
        <TabsContent value="imports" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <ImportsTab datasetId={objectId} />
        </TabsContent>
      </Tabs>

      <ShareDialog
        objectId={objectId}
        title={dataset.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: dataset.name })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          trash.mutate()
          setDeleteOpen(false)
        }}
      />
      {importOpen ? (
        <ImportWizard
          spaceId={dataset.spaceId}
          dataset={dataset}
          onClose={() => {
            setImportOpen(false)
            void client.invalidateQueries({ queryKey: dataKeys.dataset(objectId) })
            void client.invalidateQueries({ queryKey: dataKeys.versions(objectId) })
            void client.invalidateQueries({ queryKey: dataKeys.imports(objectId) })
          }}
        />
      ) : null}
    </div>
  )
}

function SchemaTab({ dataset }: { dataset: DatasetRecord }) {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(null)
  const field = dataset.fields.find((item) => item.key === selected)
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-4">
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-surface-2 text-xs text-fg-secondary">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t('data.dataset.schema.field')}
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t('data.dataset.schema.key')}
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t('data.dataset.schema.type')}
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t('data.dataset.schema.semantic')}
                </th>
                <th scope="col" className="px-4 py-2 text-left font-medium">
                  {t('data.dataset.schema.flags')}
                </th>
              </tr>
            </thead>
            <tbody>
              {dataset.fields.map((field) => (
                <tr
                  key={field.id}
                  className={cn(
                    'border-t border-line',
                    field.key === selected && 'bg-accent-subtle',
                  )}
                >
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      aria-pressed={field.key === selected}
                      onClick={() => setSelected(field.key)}
                      className="rounded-xs text-left text-fg hover:text-accent"
                    >
                      {field.label.ru ?? field.key}
                    </button>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-fg-secondary">{field.key}</td>
                  <td className="px-4 py-2 text-fg-secondary">{t(`data.types.${field.type}`)}</td>
                  <td className="px-4 py-2 text-fg-secondary">
                    {t(`data.semantics.${field.semantic}`)}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {dataset.primaryKey.includes(field.key) ? (
                        <Badge size="sm" tone="accent">
                          {t('data.dataset.schema.primaryKey')}
                        </Badge>
                      ) : null}
                      {dataset.timeField === field.key ? (
                        <Badge size="sm">{t('data.dataset.schema.time')}</Badge>
                      ) : null}
                      {field.required ? (
                        <Badge size="sm">{t('data.dataset.schema.required')}</Badge>
                      ) : null}
                      {field.indexed ? (
                        <Badge size="sm" tone="outline">
                          {t('data.dataset.schema.indexed')}
                        </Badge>
                      ) : null}
                      {field.sensitive ? (
                        <Badge size="sm" tone="warning">
                          {t('data.dataset.schema.sensitive')}
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {field ? (
        <FieldProfilePanel datasetId={dataset.id} field={field} />
      ) : (
        <p className="text-center text-xs text-fg-muted">{t('data.dataset.profile.pick')}</p>
      )}
    </div>
  )
}

const NUMERIC_TYPES = new Set(['integer', 'number', 'decimal', 'money', 'percent'])

/** Значение профиля текстом по типу поля: числа и даты — в локали пользователя. */
function profileValue(value: string | null, type: string, locale: Locale): string {
  if (value === null) return '—'
  if (NUMERIC_TYPES.has(type)) return formatNumber(Number(value), {}, { locale })
  if (type === 'date') return formatDate(value, { locale })
  if (type === 'datetime') return formatDateTime(value, { locale })
  return value
}

function FieldProfilePanel({ datasetId, field }: { datasetId: string; field: DatasetField }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: profile, error, isLoading } = useQuery(fieldProfileQuery(datasetId, field.key))
  const label = field.label.ru ?? field.key
  const number = (value: number) => formatNumber(value, {}, { locale })

  let body: ReactNode
  if (isLoading) {
    body = <Skeleton className="h-32 w-full" />
  } else if (error || !profile) {
    body = (
      <Callout tone={error instanceof ApiError && error.status === 403 ? 'info' : 'danger'}>
        {error instanceof ApiError && error.status === 403
          ? t('data.dataset.profile.restricted')
          : t('data.dataset.profile.failed')}
      </Callout>
    )
  } else {
    const filled = profile.rows - profile.empty
    body = (
      <div className="flex flex-col gap-4">
        {profile.masked ? <Callout tone="info">{t('data.dataset.profile.masked')}</Callout> : null}
        <KeyValueList
          items={[
            {
              key: 'rows',
              label: t('data.dataset.profile.rows'),
              value: profile.sampled
                ? `${number(profile.rows)} · ${t('data.dataset.profile.sampled')}`
                : number(profile.rows),
            },
            {
              key: 'empty',
              label: t('data.dataset.profile.empty'),
              value: `${number(profile.empty)} · ${formatPercent(
                profile.rows > 0 ? profile.empty / profile.rows : 0,
                {},
                { locale },
              )}`,
            },
            ...(profile.type === 'geometry'
              ? []
              : [
                  {
                    key: 'distinct',
                    label: t('data.dataset.profile.distinct'),
                    value: number(profile.distinct),
                  },
                ]),
            ...(profile.min !== null
              ? [
                  {
                    key: 'min',
                    label: t('data.dataset.profile.min'),
                    value: profileValue(profile.min, profile.type, locale),
                  },
                  {
                    key: 'max',
                    label: t('data.dataset.profile.max'),
                    value: profileValue(profile.max, profile.type, locale),
                  },
                ]
              : []),
            ...(profile.mean !== null
              ? [
                  {
                    key: 'mean',
                    label: t('data.dataset.profile.mean'),
                    value: number(profile.mean),
                  },
                ]
              : []),
          ]}
        />
        {profile.histogram.length > 0 ? (
          <section
            aria-label={t('data.dataset.profile.distribution')}
            className="flex flex-col gap-1"
          >
            <h3 className="text-xs font-medium text-fg-secondary">
              {t('data.dataset.profile.distribution')}
            </h3>
            <Histogram
              values={profile.histogram.map((bin) => bin.count)}
              label={t('data.dataset.profile.distribution')}
            />
            <div className="flex justify-between text-2xs text-fg-muted tabular">
              <span>{profileValue(profile.histogram[0]?.from ?? null, profile.type, locale)}</span>
              <span>
                {profileValue(profile.histogram.at(-1)?.to ?? null, profile.type, locale)}
              </span>
            </div>
          </section>
        ) : null}
        {profile.top.length > 0 ? (
          <section aria-label={t('data.dataset.profile.top')} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-fg-secondary">
              {t('data.dataset.profile.top')}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {profile.top.map((item) => (
                <li
                  key={item.value}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3"
                >
                  <span className="truncate text-sm text-fg">{item.value}</span>
                  <span className="tabular text-xs text-fg-secondary">{number(item.count)}</span>
                  <ProgressBar
                    value={filled > 0 ? item.count / filled : 0}
                    className="col-span-2"
                    label={item.value}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    )
  }
  return <Card title={t('data.dataset.profile.title', { field: label })}>{body}</Card>
}

function VersionsTab({ datasetId, current }: { datasetId: string; current: number }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: versions = [], isLoading } = useQuery(datasetVersionsQuery(datasetId))
  if (isLoading) return <Skeleton className="mx-auto h-40 max-w-[760px]" />
  if (versions.length === 0) return <EmptyState title={t('data.dataset.versions.empty')} />
  const number = (value: number) => formatNumber(value, {}, { locale })
  return (
    <div className="mx-auto max-w-[760px]">
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {versions.map((version) => (
            <li key={version.number} className="flex items-center gap-3 px-4 py-2.5">
              <History className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm text-fg">
                  {t('data.dataset.version', { number: version.number })}
                  <Badge size="sm" tone={version.number === current ? 'accent' : 'neutral'}>
                    {t(`data.dataset.versions.origin.${version.origin}`)}
                  </Badge>
                </span>
                <span className="block text-xs text-fg-muted">
                  {version.createdBy?.displayName ?? '—'} ·{' '}
                  {formatRelativeTime(version.createdAt, { locale })} ·{' '}
                  {t('data.dataset.rows', { count: version.rowCount })}
                </span>
              </span>
              <span className="shrink-0 tabular text-xs text-fg-secondary">
                {t('data.dataset.versions.diff', {
                  added: number(version.diff.added),
                  updated: number(version.diff.updated),
                  deleted: number(version.diff.deleted),
                })}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function ImportsTab({ datasetId }: { datasetId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: imports = [], isLoading } = useQuery(datasetImportsQuery(datasetId))
  if (isLoading) return <Skeleton className="mx-auto h-40 max-w-[760px]" />
  if (imports.length === 0) return <EmptyState title={t('data.dataset.imports.empty')} />
  const number = (value: number) => formatNumber(value, {}, { locale })
  return (
    <div className="mx-auto max-w-[760px]">
      <Card padded={false}>
        <ul className="divide-y divide-line">
          {imports.map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
              <Upload className="size-4 shrink-0 text-fg-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm text-fg">
                  {formatRelativeTime(item.createdAt, { locale })}
                  <Badge size="sm" tone={IMPORT_TONES[item.status]}>
                    {t(`data.import.status.${item.status}`)}
                  </Badge>
                  {item.version ? (
                    <span className="text-xs text-fg-muted">
                      {t('data.dataset.version', { number: item.version })}
                    </span>
                  ) : null}
                </span>
                <span className="block text-xs text-fg-muted">
                  {t('data.import.progress.stats', {
                    inserted: number(item.stats.inserted),
                    updated: number(item.stats.updated),
                    deleted: number(item.stats.deleted),
                    errors: number(item.stats.errors),
                  })}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
