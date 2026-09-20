import type { DatasetRecord, DatasetVersion, ImportRecord } from '@kchs/contracts'
import { formatNumber, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  type BadgeProps,
  Button,
  Card,
  EmptyState,
  IconButton,
  InlineEdit,
  ObjectIcon,
  PanelToolbar,
  Sheet,
  SheetContent,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3,
  History,
  Radar,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { ChoroplethButton } from '~/features/gis/choropleth/choropleth-button.js'
import { ShowOnMapButton } from '~/features/gis/show-on-map.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys, objectQuery } from '~/shared/api/queries.js'
import { AccessTab } from './access-tab.js'
import { AnalysisDialog } from './analysis-dialog.js'
import { ColumnarCard } from './columnar-card.js'
import { DatasetTable } from './dataset-table.js'
import { ImportChanges } from './import-review.js'
import { ImportWizard } from './import-wizard.js'
import { QualityTab } from './quality-tab.js'
import {
  aiStatusQuery,
  dataKeys,
  datasetImportsQuery,
  datasetQuery,
  datasetVersionsQuery,
  importQuery,
} from './queries.js'
import { SchemaTab } from './schema-tab.js'

const IMPORT_TONES: Record<ImportRecord['status'], BadgeProps['tone']> = {
  queued: 'neutral',
  normalizing: 'accent',
  comparing: 'accent',
  review: 'warning',
  loading: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
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
  const openTab = useWorkspace((s) => s.openTab)

  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [analysisOpen, setAnalysisOpen] = useState(false)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: dataset, isLoading } = useQuery(datasetQuery(objectId))
  const { data: ai } = useQuery(aiStatusQuery())

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
  const openExplore = () =>
    openTab({
      kind: 'screen',
      screen: 'explore',
      title: `${dataset.name} — ${t('data.explore.title')}`,
      params: { datasetId: objectId },
      mode: 'permanent',
    })
  const canEdit = ['edit', 'manage', 'owner'].includes(level)
  const canManage = ['manage', 'owner'].includes(level)
  // Пространственный анализ — для датасета с геометрией (результат — новый датасет)
  const hasGeometry = dataset.fields.some((field) => field.type === 'geometry')

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
            {ai?.enabled ? (
              // Поле вопроса — вверху «Исследования»: ответ ложится в его конструктор
              <Button
                variant="secondary"
                size="sm"
                icon={<Sparkles className="size-3.5" />}
                onClick={openExplore}
              >
                {t('data.ask.open')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<BarChart3 className="size-3.5" />}
              onClick={openExplore}
            >
              {t('data.explore.open')}
            </Button>
            {hasGeometry ? <ShowOnMapButton dataset={dataset} /> : null}
            {hasGeometry ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Radar className="size-3.5" />}
                onClick={() => setAnalysisOpen(true)}
              >
                {t('data.analysis.action')}
              </Button>
            ) : null}
            <ChoroplethButton dataset={dataset} />
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

      <Tabs defaultValue="table" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="table">{t('data.dataset.tabs.table')}</TabsTrigger>
          <TabsTrigger value="schema" count={dataset.fields.length}>
            {t('data.dataset.tabs.schema')}
          </TabsTrigger>
          <TabsTrigger value="versions">{t('data.dataset.tabs.versions')}</TabsTrigger>
          <TabsTrigger value="imports">{t('data.dataset.tabs.imports')}</TabsTrigger>
          <TabsTrigger value="quality">{t('data.dataset.tabs.quality')}</TabsTrigger>
          {canManage ? (
            <TabsTrigger value="access">{t('data.dataset.tabs.access')}</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="table" className="min-h-0 flex-1">
          <DatasetTable dataset={dataset} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="schema" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <SchemaTab dataset={dataset} canManage={canManage} />
        </TabsContent>
        <TabsContent value="versions" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <VersionsTab
            datasetId={objectId}
            current={dataset.currentVersion}
            canManage={canManage}
          />
        </TabsContent>
        {canManage ? (
          <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
            <AccessTab dataset={dataset} />
          </TabsContent>
        ) : null}
        <TabsContent value="imports" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <ImportsTab dataset={dataset} canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="quality" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <QualityTab dataset={dataset} />
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
      {analysisOpen ? (
        <AnalysisDialog dataset={dataset} onClose={() => setAnalysisOpen(false)} />
      ) : null}
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

/**
 * Версии датасета; управляющий откатывает к прежней версии (ADR-0062) — новой
 * версией «Откат». Почему откат невозможен, объясняет сервер.
 */
function VersionsTab({
  datasetId,
  current,
  canManage,
}: {
  datasetId: string
  current: number
  canManage: boolean
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const [target, setTarget] = useState<number | null>(null)
  const { data: versions = [], isLoading } = useQuery(datasetVersionsQuery(datasetId))
  const rollback = useMutation({
    mutationFn: (number: number) =>
      http.post<DatasetVersion>(`/datasets/${datasetId}/versions/${number}/rollback`),
    onSuccess: (_version, number) => {
      toast.show({ title: t('data.dataset.versions.rolledBack', { number }), tone: 'success' })
      // Строки, счётчики, профиль и история строк — всё под ключом датасета
      void client.invalidateQueries({ queryKey: dataKeys.dataset(datasetId) })
    },
    onError: (failure) =>
      toast.error(failure instanceof ApiError ? failure.message : t('errors.unknown')),
    onSettled: () => setTarget(null),
  })
  if (isLoading) return <Skeleton className="mx-auto h-40 max-w-[760px]" />
  const number = (value: number) => formatNumber(value, {}, { locale })
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      <ColumnarCard datasetId={datasetId} canManage={canManage} />
      {versions.length === 0 ? (
        <EmptyState title={t('data.dataset.versions.empty')} />
      ) : (
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
                {canManage && version.number < current ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    aria-label={t('data.dataset.versions.rollbackTo', { number: version.number })}
                    onClick={() => setTarget(version.number)}
                  >
                    {t('data.dataset.versions.rollback')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => !open && !rollback.isPending && setTarget(null)}
        title={t('data.dataset.versions.rollbackTitle', { number: target ?? 0 })}
        description={t('data.dataset.versions.rollbackHint')}
        confirmLabel={t('data.dataset.versions.rollback')}
        destructive={false}
        loading={rollback.isPending}
        onConfirm={() => {
          if (target !== null) rollback.mutate(target)
        }}
      />
    </div>
  )
}

function ImportsTab({ dataset, canEdit }: { dataset: DatasetRecord; canEdit: boolean }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const [reviewing, setReviewing] = useState<string | null>(null)
  const { data: imports = [], isLoading } = useQuery(datasetImportsQuery(dataset.id))
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
              {item.status === 'review' && canEdit ? (
                <Button variant="secondary" size="sm" onClick={() => setReviewing(item.id)}>
                  {t('data.import.changes.open')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {reviewing ? (
        <Sheet open onOpenChange={(open) => !open && setReviewing(null)}>
          <SheetContent title={t('data.import.changes.title')} width="min(860px, 100vw)">
            <ReviewSheet
              importId={reviewing}
              dataset={dataset}
              onDone={() => {
                setReviewing(null)
                void client.invalidateQueries({ queryKey: dataKeys.dataset(dataset.id) })
              }}
            />
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  )
}

/** Сводка изменений импорта, ждущего публикации (ADR-0068). */
function ReviewSheet({
  importId,
  dataset,
  onDone,
}: {
  importId: string
  dataset: DatasetRecord
  onDone: () => void
}) {
  const { data: record } = useQuery(importQuery(importId))
  if (!record) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    )
  }
  return (
    <ImportChanges
      record={record}
      fields={dataset.fields}
      currentVersion={dataset.currentVersion}
      onDone={onDone}
    />
  )
}
