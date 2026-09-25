import type { ObjectSummary, Space } from '@kchs/contracts'
import { formatFileSize, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Breadcrumbs,
  Button,
  type CollectionState,
  CollectionView,
  cn,
  type DataTableColumn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  ObjectIcon,
  PanelToolbar,
  ProgressBar,
  useBreakpoint,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Download,
  FolderInput,
  FolderPlus,
  Paperclip,
  Pencil,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react'
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import {
  type Movable,
  MoveDialog,
  moveObjects,
  RenameDialog,
} from '~/features/files/move-dialog.js'
import { UploadInterruptedError, uploadFile } from '~/features/files/upload.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { http } from '~/shared/api/client.js'
import { attachmentsFolderQuery, spacesQuery } from '~/shared/api/queries.js'
import { emptyCollectionState } from '~/shared/collections/collection-state.js'
import { SavedViewsMenu } from '~/shared/collections/saved-views-menu.js'
import { useListFields } from '~/shared/collections/use-list-fields.js'
import { useObjectCollection } from '~/shared/collections/use-object-collection.js'
import {
  describeUserFilterValue,
  renderUserFilterValue,
} from '~/shared/collections/user-filter-value.js'
import { orderSpaces } from '~/shared/spaces.js'

const TYPES = ['folder', 'file']
/** Тип данных перетаскивания объектов списка: отличает их от файлов с диска. */
const DRAG_OBJECTS = 'application/x-kchs-objects'

/** Категория файла для доски: папки, документы, таблицы, изображения, прочее. */
type FileCategory = 'folder' | 'document' | 'spreadsheet' | 'image' | 'other'

function categoryOf(item: ObjectSummary): FileCategory {
  if (item.type === 'folder') return 'folder'
  const mime = String(item.meta.mime ?? '')
  if (mime.startsWith('image/')) return 'image'
  if (/spreadsheet|excel|csv/.test(mime)) return 'spreadsheet'
  if (/pdf|word|document|text|rtf|presentation/.test(mime)) return 'document'
  return 'other'
}

export function FilesScreen({
  spaceId: initialSpaceId,
  tabId,
  savedState,
}: {
  spaceId?: string
  tabId?: string
  /** Состояние списка из вкладки: переживает перезагрузку («Продолжить»). */
  savedState?: { collection?: CollectionState; viewId?: string | null }
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)
  const download = useFileDownload()

  const { data: spaces = [] } = useQuery(spacesQuery())
  const [spaceId, setSpaceId] = useState<string | undefined>(initialSpaceId)
  const [path, setPath] = useState<Array<{ id: string; title: string }>>([])
  const breakpoint = useBreakpoint()
  const [collection, setCollection] = useState<CollectionState>(
    () => savedState?.collection ?? emptyCollectionState('table'),
  )
  const [viewId, setViewId] = useState<string | null>(savedState?.viewId ?? null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragActive, setDragActive] = useState(false)
  const [uploads, setUploads] = useState<Record<string, number>>({})
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [shareTarget, setShareTarget] = useState<ObjectSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ObjectSummary | null>(null)
  const [moveTargets, setMoveTargets] = useState<Movable[] | null>(null)
  const [renameTarget, setRenameTarget] = useState<Movable | null>(null)
  // Папка, над которой тащат файлы списка: подсветка цели перетаскивания
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // На узком экране таблица нечитаема — переключаемся на плитки
  useEffect(() => {
    if (breakpoint === 'mobile') setCollection((current) => ({ ...current, mode: 'gallery' }))
  }, [breakpoint])

  // Состояние списка — во вкладке: сохраняется на сервере вместе с рабочим пространством
  useEffect(() => {
    if (tabId) setTabState(tabId, { collection, viewId })
  }, [tabId, collection, viewId, setTabState])

  const effectiveSpaceId = spaceId ?? orderSpaces(spaces)[0]?.id
  // Файлы-вложения лежат в системной папке пространства (09-files.md §1): в корне
  // её нет, вход — отдельной кнопкой; внутри неё новые папки и загрузка не нужны
  const { data: attachmentsFolderId = null } = useQuery({
    ...attachmentsFolderQuery(effectiveSpaceId ?? ''),
    enabled: Boolean(effectiveSpaceId),
  })
  const inAttachments = Boolean(attachmentsFolderId && path[0]?.id === attachmentsFolderId)
  // Архивное пространство — только чтение (ADR-0152): загрузка и перестановка скрыты
  const archived = Boolean(spaces.find((space) => space.id === effectiveSpaceId)?.archivedAt)
  const readOnly = inAttachments || archived
  const parentId = path[path.length - 1]?.id
  const { fields, sortable } = useListFields(TYPES)
  // Фильтр или поиск ищут по всему пространству, без них — содержимое текущей папки
  const searching = Boolean(collection.filter || collection.search.trim())
  const { rows, total, loading, hasMore, loadMore } = useObjectCollection(
    {
      types: TYPES,
      spaceId: effectiveSpaceId,
      parentId: searching ? undefined : (parentId ?? 'root'),
    },
    // Папки всегда выше файлов: сортировка по умолчанию — от сервера (свежие сверху)
    collection,
    Boolean(effectiveSpaceId),
  )
  const items = useMemo(
    () => [...rows.filter((r) => r.type === 'folder'), ...rows.filter((r) => r.type === 'file')],
    [rows],
  )

  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['objects'] })
  }, [client])

  const createFolder = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/folders', {
        name: folderName.trim(),
        spaceId: effectiveSpaceId,
        parentId: parentId ?? null,
      }),
    onSuccess: () => {
      setCreateFolderOpen(false)
      setFolderName('')
      refresh()
      toast.show({ title: t('files.folder.created'), tone: 'success' })
    },
    onError: () => toast.error(t('files.folder.createFailed')),
  })

  const trash = useMutation({
    mutationFn: (objectId: string) => http.delete(`/objects/${objectId}`),
    onSuccess: (_result, objectId) => {
      refresh()
      toast.show({
        title: t('objects.trash.movedTo'),
        tone: 'info',
        action: {
          label: t('common.actions.undo'),
          onClick: () => {
            void http.post(`/objects/${objectId}/restore`).then(refresh)
          },
        },
      })
    },
  })

  const handleFiles = async (fileList: FileList | File[] | null): Promise<void> => {
    if (!fileList?.length || !effectiveSpaceId) return
    for (const file of Array.from(fileList)) {
      const key = `${file.name}-${file.size}`
      setUploads((current) => ({ ...current, [key]: 0 }))
      try {
        await uploadFile({
          file,
          spaceId: effectiveSpaceId,
          folderId: parentId ?? null,
          onProgress: (progress) => setUploads((current) => ({ ...current, [key]: progress })),
        })
        toast.show({ title: t('files.upload.done', { name: file.name }), tone: 'success' })
      } catch (error) {
        if (error instanceof UploadInterruptedError) {
          // Сессия жива: повтор продолжит с первой недокачанной части
          toast.show({
            title: error.message,
            description: file.name,
            tone: 'warning',
            duration: 60_000,
            action: {
              label: t('files.upload.resume'),
              onClick: () => void handleFiles([file]),
            },
          })
        } else {
          toast.error(t('files.upload.failed'), file.name)
        }
      } finally {
        setUploads((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
        refresh()
      }
    }
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragActive(false)
    // Перетаскивание объектов списка обрабатывает папка-цель, здесь — файлы с диска
    if (event.dataTransfer.types.includes(DRAG_OBJECTS)) return
    void handleFiles(event.dataTransfer.files)
  }

  const movable = (item: ObjectSummary): Movable => ({
    id: item.id,
    type: item.type,
    title: item.title,
    spaceId: item.spaceId,
  })

  // Перетащить объекты списка на папку: выделенные вместе, если тащат одну из них
  const startDrag = (event: DragEvent, item: ObjectSummary): void => {
    const ids = selected.has(item.id) ? [...selected] : [item.id]
    event.dataTransfer.setData(DRAG_OBJECTS, JSON.stringify(ids))
    event.dataTransfer.effectAllowed = 'move'
  }

  const dropTargetProps = (folder: ObjectSummary) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_OBJECTS)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      setDropFolderId(folder.id)
    },
    onDragLeave: () => setDropFolderId((current) => (current === folder.id ? null : current)),
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_OBJECTS)) return
      event.preventDefault()
      event.stopPropagation()
      setDropFolderId(null)
      const ids = JSON.parse(event.dataTransfer.getData(DRAG_OBJECTS) || '[]') as string[]
      const dragged = items.filter((row) => ids.includes(row.id) && row.id !== folder.id)
      if (dragged.length === 0 || !effectiveSpaceId) return
      void moveObjects(dragged.map(movable), {
        spaceId: effectiveSpaceId,
        parentId: folder.id,
      }).then((result) => {
        refresh()
        setSelected(new Set())
        if (result.failed.length > 0) {
          toast.error(
            t('files.move.failed', { count: result.failed.length }),
            result.failed.map((failure) => `${failure.title}: ${failure.reason}`).join('\n'),
          )
        } else {
          toast.show({
            title: t('files.move.movedTo', { count: result.moved, folder: folder.title }),
            tone: 'success',
          })
        }
      })
    },
  })

  const openObject = (item: ObjectSummary, permanent = false): void => {
    if (item.type === 'folder') {
      setPath((current) => [...current, { id: item.id, title: item.title }])
      setSelected(new Set())
      return
    }
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
      header: t('files.columns.name'),
      sortable: sortable.includes('title'),
      cell: (item) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: перетаскивание — ускоритель для мыши; с клавиатуры то же делает «Переместить» в строке
        <span
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-xs',
            dropFolderId === item.id && 'bg-accent-subtle ring-1 ring-accent',
          )}
          draggable={!readOnly}
          onDragStart={(event) => startDrag(event, item)}
          {...(item.type === 'folder' ? dropTargetProps(item) : {})}
        >
          <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate">{item.title}</span>
          {item.type === 'folder' ? (
            <ChevronRight className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
          ) : null}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('files.columns.size'),
      width: 112,
      align: 'end',
      sortable: sortable.includes('size'),
      cell: (item) => (
        <span className="text-xs text-fg-secondary">
          {typeof item.meta.size === 'number' ? formatFileSize(item.meta.size, { locale }) : '—'}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      header: t('files.columns.modified'),
      width: 150,
      sortable: sortable.includes('updatedAt'),
      cell: (item) => (
        <span className="text-xs text-fg-secondary">
          {formatRelativeTime(item.updatedAt, { locale })}
        </span>
      ),
    },
    {
      key: 'version',
      header: t('files.columns.version'),
      width: 88,
      cell: (item) =>
        typeof item.meta.version === 'number' ? (
          <Badge size="sm">v{item.meta.version}</Badge>
        ) : (
          <span className="text-xs text-fg-muted">—</span>
        ),
    },
  ]

  return (
    <section
      aria-label={t('shell.rail.files')}
      className={cn('flex h-full min-h-0 flex-col', dragActive && 'ring-2 ring-inset ring-accent')}
      onDragOver={(event) => {
        event.preventDefault()
        // Подсветка приёма — только для файлов с диска, не для объектов списка
        if (event.dataTransfer.types.includes('Files')) setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
    >
      <PanelToolbar
        left={
          <Breadcrumbs
            items={[
              {
                id: 'space',
                label: spaces.find((s) => s.id === effectiveSpaceId)?.name ?? t('shell.rail.files'),
                onClick: () => setPath([]),
              },
              ...path.map((node, index) => ({
                id: node.id,
                label: node.title,
                onClick: () => setPath((current) => current.slice(0, index + 1)),
              })),
            ]}
          />
        }
        right={
          <>
            {attachmentsFolderId && !inAttachments ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<Paperclip className="size-3.5" />}
                onClick={() =>
                  setPath([{ id: attachmentsFolderId, title: t('files.attachmentsFolder') }])
                }
              >
                {t('files.attachmentsFolder')}
              </Button>
            ) : null}
            {readOnly ? null : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FolderPlus className="size-3.5" />}
                  onClick={() => setCreateFolderOpen(true)}
                >
                  {t('files.folder.create')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Upload className="size-3.5" />}
                  onClick={() => inputRef.current?.click()}
                >
                  {t('common.actions.upload')}
                </Button>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => void handleFiles(event.target.files)}
            />
          </>
        }
      />

      {spaces.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-surface-2 px-2.5 py-1.5">
          {orderSpaces(spaces).map((space: Space) => (
            <button
              key={space.id}
              type="button"
              onClick={() => {
                setSpaceId(space.id)
                setPath([])
              }}
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

      {Object.keys(uploads).length > 0 ? (
        <div className="flex flex-col gap-1.5 border-b border-line bg-surface-2 px-3 py-2">
          {Object.entries(uploads).map(([key, progress]) => (
            <div key={key} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">
                {t('files.upload.uploading', { name: key.split('-')[0] ?? '' })}
              </span>
              <ProgressBar value={progress} className="w-40" showValue />
            </div>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <CollectionView
          aria-label={t('shell.rail.files')}
          rows={items}
          getRowId={(item) => item.id}
          state={collection}
          onStateChange={(next) => {
            setCollection(next)
            setSelected(new Set())
          }}
          fields={fields}
          sortableFields={sortable}
          columns={columns}
          modes={['table', 'gallery', 'board']}
          total={total}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          selection={selected}
          onSelectionChange={setSelected}
          bulkActions={
            <>
              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<FolderInput className="size-3.5" />}
                  onClick={() =>
                    setMoveTargets(items.filter((item) => selected.has(item.id)).map(movable))
                  }
                >
                  {t('files.move.action')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => {
                  for (const id of selected) trash.mutate(id)
                  setSelected(new Set())
                }}
              >
                {t('common.actions.delete')}
              </Button>
            </>
          }
          onRowClick={(item) => openObject(item)}
          onRowOpen={(item) => openObject(item, true)}
          rowActions={(item) => (
            <>
              <IconButton
                label={t('common.actions.share')}
                size="sm"
                onClick={() => setShareTarget(item)}
              >
                <Share2 className="size-3.5" />
              </IconButton>
              {readOnly ? null : (
                <>
                  <IconButton
                    label={t('files.move.actionFor', { name: item.title })}
                    size="sm"
                    onClick={() => setMoveTargets([movable(item)])}
                  >
                    <FolderInput className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={t('files.rename.actionFor', { name: item.title })}
                    size="sm"
                    onClick={() => setRenameTarget(movable(item))}
                  >
                    <Pencil className="size-3.5" />
                  </IconButton>
                </>
              )}
              {item.type === 'file' ? (
                <IconButton
                  label={t('common.actions.download')}
                  size="sm"
                  onClick={() => download.mutate({ fileId: item.id })}
                >
                  <Download className="size-3.5" />
                </IconButton>
              ) : null}
              <IconButton
                label={t('common.actions.delete')}
                size="sm"
                variant="danger"
                onClick={() => setDeleteTarget(item)}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </>
          )}
          renderTile={(item) => (
            <button
              type="button"
              onClick={() => openObject(item)}
              onDoubleClick={() => openObject(item, true)}
              draggable={!readOnly}
              onDragStart={(event) => startDrag(event, item)}
              {...(item.type === 'folder' ? dropTargetProps(item) : {})}
              className={cn(
                'flex w-full flex-col items-start gap-2 rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2',
                dropFolderId === item.id && 'border-accent bg-accent-subtle',
              )}
            >
              <ObjectIcon type={item.type} className="size-8 text-fg-muted" />
              <span className="line-clamp-2 text-sm text-fg">{item.title}</span>
              <span className="text-2xs text-fg-muted">
                {typeof item.meta.size === 'number'
                  ? formatFileSize(item.meta.size, { locale })
                  : t('objects.types.folder')}
              </span>
            </button>
          )}
          board={{
            columns: (['folder', 'document', 'spreadsheet', 'image', 'other'] as const).map(
              (key) => ({ key, title: t(`files.categories.${key}`) }),
            ),
            getColumnKey: categoryOf,
            renderCard: (item) => (
              <span className="flex items-center gap-2">
                <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                <span className="truncate">{item.title}</span>
              </span>
            ),
          }}
          viewsMenu={
            <SavedViewsMenu
              objectType="file"
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
            <EmptyState
              icon={<Upload />}
              title={searching ? t('common.states.nothingFound') : t('files.empty')}
              description={searching ? undefined : t('files.upload.drop')}
              action={
                searching ? undefined : (
                  <Button variant="primary" onClick={() => inputRef.current?.click()}>
                    {t('files.emptyHint')}
                  </Button>
                )
              }
            />
          }
        />
      </div>

      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent
          title={t('files.folder.create')}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreateFolderOpen(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={!folderName.trim()}
                loading={createFolder.isPending}
                onClick={() => createFolder.mutate()}
              >
                {t('common.actions.create')}
              </Button>
            </>
          }
        >
          <Field label={t('files.folder.name')} htmlFor="folder-name">
            <Input
              id="folder-name"
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && folderName.trim()) createFolder.mutate()
              }}
            />
          </Field>
        </DialogContent>
      </Dialog>

      {moveTargets && effectiveSpaceId ? (
        <MoveDialog
          items={moveTargets}
          spaceId={effectiveSpaceId}
          excludeFolderId={attachmentsFolderId}
          onClose={() => {
            setMoveTargets(null)
            setSelected(new Set())
          }}
        />
      ) : null}
      {renameTarget ? (
        <RenameDialog item={renameTarget} onClose={() => setRenameTarget(null)} />
      ) : null}

      {shareTarget ? (
        <ShareDialog
          objectId={shareTarget.id}
          title={shareTarget.title}
          open
          onOpenChange={(open) => !open && setShareTarget(null)}
        />
      ) : null}

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('objects.deleteConfirm', { title: deleteTarget?.title ?? '' })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          if (deleteTarget) trash.mutate(deleteTarget.id)
          setDeleteTarget(null)
        }}
      />
    </section>
  )
}
