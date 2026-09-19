import type { ObjectSummary } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  Button,
  Callout,
  type CollectionState,
  CollectionView,
  cn,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  ObjectIcon,
  PanelToolbar,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Map as MapIcon, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { emptyCollectionState } from '~/shared/collections/collection-state.js'
import { useListFields } from '~/shared/collections/use-list-fields.js'
import { useObjectCollection } from '~/shared/collections/use-object-collection.js'
import { orderSpaces } from '~/shared/spaces.js'

const TYPES = ['map', 'layer']

/**
 * Экран «Карты» (03-screens.md §10): карты и слои пространства, создание
 * карты. Карта открывается студией, слой — просмотром со своей легендой.
 */
export function MapsScreen({
  tabId,
  savedState,
}: {
  tabId?: string
  savedState?: { collection?: CollectionState; spaceId?: string }
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const { data: spaces = [] } = useQuery(spacesQuery())
  const [spaceId, setSpaceId] = useState<string | undefined>(savedState?.spaceId)
  const [collection, setCollection] = useState<CollectionState>(
    () => savedState?.collection ?? emptyCollectionState('table'),
  )
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (tabId) setTabState(tabId, { collection, ...(spaceId ? { spaceId } : {}) })
  }, [tabId, collection, spaceId, setTabState])

  const ordered = orderSpaces(spaces)
  const effectiveSpaceId = spaceId ?? ordered[0]?.id
  const { fields, sortable } = useListFields(TYPES)
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

  const columns: Array<DataTableColumn<ObjectSummary>> = [
    {
      key: 'title',
      header: t('gis.maps.columns.name'),
      sortable: sortable.includes('title'),
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2">
          <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate">{item.title}</span>
        </span>
      ),
    },
    {
      key: 'type',
      header: t('gis.maps.columns.type'),
      width: 140,
      cell: (item) => (
        <span className="text-xs text-fg-secondary">{t(`objects.types.${item.type}`)}</span>
      ),
    },
    {
      key: 'updatedAt',
      header: t('gis.maps.columns.updated'),
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
    <section aria-label={t('shell.rail.maps')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <span className="truncate text-sm font-semibold text-fg">
            {spaces.find((space) => space.id === effectiveSpaceId)?.name ?? t('shell.rail.maps')}
          </span>
        }
        right={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={!effectiveSpaceId}
            onClick={() => setCreating(true)}
          >
            {t('gis.maps.create')}
          </Button>
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
          aria-label={t('shell.rail.maps')}
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
              <span className="text-2xs text-fg-muted">{t(`objects.types.${item.type}`)}</span>
            </button>
          )}
          empty={
            <EmptyState
              icon={<MapIcon />}
              title={t('gis.maps.empty')}
              description={t('gis.maps.emptyHint')}
            />
          }
        />
      </div>
      {creating && effectiveSpaceId ? (
        <CreateMapDialog spaceId={effectiveSpaceId} onClose={() => setCreating(false)} />
      ) : null}
    </section>
  )
}

function CreateMapDialog({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: () => http.post<{ id: string }>('/gis/maps', { name: name.trim(), spaceId }),
    onSuccess: ({ id }) => {
      toast.show({ title: t('gis.maps.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'map',
        title: name.trim(),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('gis.maps.createTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!name.trim()}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('gis.maps.name')}>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && name.trim()) create.mutate()
              }}
              aria-label={t('gis.maps.name')}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
