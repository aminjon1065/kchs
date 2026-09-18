import type { ObjectSummary } from '@kchs/contracts'
import { formatNumber, formatRelativeTime } from '@kchs/fields'
import {
  Button,
  type CollectionState,
  CollectionView,
  cn,
  type DataTableColumn,
  EmptyState,
  FileDropzone,
  ObjectIcon,
  PanelToolbar,
  useBreakpoint,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { emptyCollectionState } from '~/shared/collections/collection-state.js'
import { SavedViewsMenu } from '~/shared/collections/saved-views-menu.js'
import { useListFields } from '~/shared/collections/use-list-fields.js'
import { useObjectCollection } from '~/shared/collections/use-object-collection.js'
import {
  describeUserFilterValue,
  renderUserFilterValue,
} from '~/shared/collections/user-filter-value.js'
import { orderSpaces } from '~/shared/spaces.js'
import { CreateDashboardDialog } from './dashboard-dialogs.js'
import { ImportWizard } from './import-wizard.js'

/** Типы каталога «Данные»; показатели, тетради и отчёты добавятся с их модулями. */
const TYPES = ['dataset', 'chart', 'dashboard']

/**
 * Каталог «Данные» (03-screens.md §4): объекты данных пространства в
 * CollectionView, загрузка файла — мастер импорта; пустой каталог — крупная зона.
 */
export function DataCatalogScreen({
  spaceId: initialSpaceId,
  tabId,
  savedState,
}: {
  spaceId?: string
  tabId?: string
  savedState?: { collection?: CollectionState; viewId?: string | null }
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const breakpoint = useBreakpoint()

  const { data: spaces = [] } = useQuery(spacesQuery())
  const [spaceId, setSpaceId] = useState<string | undefined>(initialSpaceId)
  const [collection, setCollection] = useState<CollectionState>(
    () => savedState?.collection ?? emptyCollectionState('table'),
  )
  const [viewId, setViewId] = useState<string | null>(savedState?.viewId ?? null)
  const [wizard, setWizard] = useState<{ file: File | null } | null>(null)
  const [creatingDashboard, setCreatingDashboard] = useState(false)

  useEffect(() => {
    if (breakpoint === 'mobile') setCollection((current) => ({ ...current, mode: 'gallery' }))
  }, [breakpoint])

  useEffect(() => {
    if (tabId) setTabState(tabId, { collection, viewId })
  }, [tabId, collection, viewId, setTabState])

  const ordered = orderSpaces(spaces)
  const effectiveSpaceId = spaceId ?? ordered[0]?.id
  const { fields, sortable } = useListFields(TYPES)
  const searching = Boolean(collection.filter || collection.search.trim())
  const { rows, total, loading, hasMore, loadMore } = useObjectCollection(
    { types: TYPES, spaceId: effectiveSpaceId },
    collection,
    Boolean(effectiveSpaceId),
  )

  const openObject = (item: ObjectSummary, permanent = false): void => {
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: item.type,
      title: item.title,
      mode: permanent ? 'permanent' : 'preview',
    })
  }

  const rowCount = (item: ObjectSummary) =>
    item.type === 'dataset' && typeof item.meta.rows === 'number'
      ? formatNumber(item.meta.rows, {}, { locale })
      : '—'

  const columns: Array<DataTableColumn<ObjectSummary>> = [
    {
      key: 'title',
      header: t('data.catalog.columns.name'),
      sortable: sortable.includes('title'),
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2">
          <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate">{item.title}</span>
        </span>
      ),
    },
    {
      key: 'rows',
      header: t('data.catalog.columns.rows'),
      width: 120,
      align: 'end',
      sortable: sortable.includes('rows'),
      cell: (item) => <span className="tabular text-xs text-fg-secondary">{rowCount(item)}</span>,
    },
    {
      key: 'updatedAt',
      header: t('data.catalog.columns.updated'),
      width: 150,
      sortable: sortable.includes('updatedAt'),
      cell: (item) => (
        <span className="text-xs text-fg-secondary">
          {formatRelativeTime(item.updatedAt, { locale })}
        </span>
      ),
    },
  ]

  return (
    <section aria-label={t('shell.rail.data')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <span className="truncate text-sm font-semibold text-fg">
            {spaces.find((space) => space.id === effectiveSpaceId)?.name ?? t('shell.rail.data')}
          </span>
        }
        right={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<LayoutDashboard className="size-3.5" />}
              disabled={!effectiveSpaceId}
              onClick={() => setCreatingDashboard(true)}
            >
              {t('data.dashboard.create')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Upload className="size-3.5" />}
              disabled={!effectiveSpaceId}
              onClick={() => setWizard({ file: null })}
            >
              {t('data.catalog.upload')}
            </Button>
          </>
        }
      />

      {ordered.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface-2 px-2.5 py-1.5">
          {ordered.map((space) => (
            <button
              key={space.id}
              type="button"
              onClick={() => setSpaceId(space.id)}
              className={cn(
                'shrink-0 rounded-sm px-2 py-1 text-xs font-medium transition-colors',
                space.id === effectiveSpaceId
                  ? 'bg-surface text-fg shadow-sm'
                  : 'text-fg-secondary hover:bg-surface-3 hover:text-fg',
              )}
            >
              {space.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <CollectionView
          aria-label={t('shell.rail.data')}
          rows={rows}
          getRowId={(item) => item.id}
          state={collection}
          onStateChange={setCollection}
          fields={fields}
          sortableFields={sortable}
          columns={columns}
          modes={['table', 'gallery']}
          total={total}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRowClick={(item) => openObject(item)}
          onRowOpen={(item) => openObject(item, true)}
          renderTile={(item) => (
            <button
              type="button"
              onClick={() => openObject(item)}
              onDoubleClick={() => openObject(item, true)}
              className="flex w-full flex-col items-start gap-2 rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
            >
              <ObjectIcon type={item.type} className="size-8 text-fg-muted" />
              <span className="line-clamp-2 text-sm text-fg">{item.title}</span>
              <span className="text-2xs text-fg-muted">
                {item.type === 'dataset'
                  ? t('data.dataset.rows', { count: Number(item.meta.rows ?? 0) })
                  : t(`objects.types.${item.type}`)}
              </span>
            </button>
          )}
          viewsMenu={
            <SavedViewsMenu
              objectType="dataset"
              spaceId={effectiveSpaceId}
              state={collection}
              activeViewId={viewId}
              onApply={(id, next) => {
                setViewId(id)
                setCollection(next)
              }}
            />
          }
          renderFilterValue={renderUserFilterValue}
          describeFilterValue={describeUserFilterValue}
          empty={
            searching ? (
              <EmptyState icon={<Upload />} title={t('common.states.nothingFound')} />
            ) : (
              <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3 p-6">
                <h2 className="text-md font-semibold text-fg">{t('data.catalog.empty')}</h2>
                <FileDropzone
                  multiple={false}
                  disabled={!effectiveSpaceId}
                  onFiles={(files) => files[0] && setWizard({ file: files[0] })}
                  label={t('data.catalog.emptyHint')}
                  hint={t('data.catalog.formats')}
                />
              </div>
            )
          }
        />
      </div>

      {creatingDashboard && effectiveSpaceId ? (
        <CreateDashboardDialog
          spaceId={effectiveSpaceId}
          onClose={() => setCreatingDashboard(false)}
        />
      ) : null}
      {wizard && effectiveSpaceId ? (
        <ImportWizard
          spaceId={effectiveSpaceId}
          initialFile={wizard.file}
          onClose={() => setWizard(null)}
        />
      ) : null}
    </section>
  )
}
