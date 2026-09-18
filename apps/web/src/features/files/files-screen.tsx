import type { ObjectSummary, Space } from '@kchs/contracts'
import { formatFileSize, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Breadcrumbs,
  Button,
  cn,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  IconButton,
  Input,
  ObjectIcon,
  PanelToolbar,
  ProgressBar,
  SearchInput,
  SegmentedControl,
  TableSkeleton,
  useBreakpoint,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight,
  Download,
  FolderPlus,
  Grid2X2,
  LayoutList,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react'
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { uploadFile } from '~/features/files/upload.js'
import { http } from '~/shared/api/client.js'
import { objectListQuery, spacesQuery } from '~/shared/api/queries.js'

type ViewMode = 'table' | 'grid'

export function FilesScreen({ spaceId: initialSpaceId }: { spaceId?: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const toast = useToast()
  const openTab = useWorkspace((s) => s.openTab)

  const { data: spaces = [] } = useQuery(spacesQuery())
  const [spaceId, setSpaceId] = useState<string | undefined>(initialSpaceId)
  const [path, setPath] = useState<Array<{ id: string; title: string }>>([])
  const [mode, setMode] = useState<ViewMode>('table')
  const breakpoint = useBreakpoint()
  const [search, setSearch] = useState('')
  const [selected, _setSelected] = useState<Set<string>>(new Set())
  const [dragActive, setDragActive] = useState(false)
  const [uploads, setUploads] = useState<Record<string, number>>({})
  const [createFolderOpen, setCreateFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [shareTarget, setShareTarget] = useState<ObjectSummary | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ObjectSummary | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // На узком экране таблица нечитаема — переключаемся на плитки
  useEffect(() => {
    if (breakpoint === 'mobile') setMode('grid')
  }, [breakpoint])

  const effectiveSpaceId = spaceId ?? orderSpaces(spaces)[0]?.id
  const parentId = path[path.length - 1]?.id
  const query = useDebouncedValue(search, 250)

  const { data, isLoading } = useQuery({
    ...objectListQuery({
      spaceId: effectiveSpaceId,
      parentId: parentId ?? 'root',
      types: 'folder,file',
      q: query || undefined,
      limit: 200,
    }),
    enabled: Boolean(effectiveSpaceId),
  })

  const items = data?.items ?? []
  const folders = items.filter((item) => item.type === 'folder')
  const files = items.filter((item) => item.type === 'file')

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

  const handleFiles = async (fileList: FileList | null): Promise<void> => {
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
      } catch {
        toast.error(t('files.upload.failed'), file.name)
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
    void handleFiles(event.dataTransfer.files)
  }

  const openObject = (item: ObjectSummary, permanent = false): void => {
    if (item.type === 'folder') {
      setPath((current) => [...current, { id: item.id, title: item.title }])
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

  return (
    <section
      aria-label={t('shell.rail.files')}
      className={cn('flex h-full min-h-0 flex-col', dragActive && 'ring-2 ring-inset ring-accent')}
      onDragOver={(event) => {
        event.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
    >
      <PanelToolbar
        left={
          <>
            <Breadcrumbs
              items={[
                {
                  id: 'space',
                  label:
                    spaces.find((s) => s.id === effectiveSpaceId)?.name ?? t('shell.rail.files'),
                  onClick: () => setPath([]),
                },
                ...path.map((node, index) => ({
                  id: node.id,
                  label: node.title,
                  onClick: () => setPath((current) => current.slice(0, index + 1)),
                })),
              ]}
            />
            <SearchInput
              value={search}
              onValueChange={setSearch}
              placeholder={t('common.actions.search')}
              className="ml-2 h-7 w-56"
            />
          </>
        }
        right={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('files.viewMode.label')}
              value={mode}
              onValueChange={(next) => setMode(next as ViewMode)}
              options={[
                {
                  value: 'table',
                  label: '',
                  icon: <LayoutList className="size-3.5" />,
                  title: t('files.viewMode.table'),
                },
                {
                  value: 'grid',
                  label: '',
                  icon: <Grid2X2 className="size-3.5" />,
                  title: t('files.viewMode.grid'),
                },
              ]}
            />
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <TableSkeleton rows={8} columns={4} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Upload />}
            title={t('files.empty')}
            description={t('files.upload.drop')}
            action={
              <Button variant="primary" onClick={() => inputRef.current?.click()}>
                {t('files.emptyHint')}
              </Button>
            }
          />
        ) : mode === 'table' ? (
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-(--z-sticky) bg-surface-2">
              <tr className="text-left text-xs text-fg-muted">
                <th className="h-8 border-b border-line px-3 font-medium">
                  {t('files.columns.name')}
                </th>
                <th className="h-8 w-28 border-b border-line px-3 text-right font-medium">
                  {t('files.columns.size')}
                </th>
                <th className="h-8 w-36 border-b border-line px-3 font-medium">
                  {t('files.columns.modified')}
                </th>
                <th className="h-8 w-20 border-b border-line px-3 font-medium">
                  {t('files.columns.version')}
                </th>
                <th className="h-8 w-20 border-b border-line px-3" />
              </tr>
            </thead>
            <tbody>
              {[...folders, ...files].map((item) => (
                <tr
                  key={item.id}
                  onClick={() => openObject(item)}
                  onDoubleClick={() => openObject(item, true)}
                  className={cn(
                    'group cursor-pointer',
                    selected.has(item.id) ? 'bg-accent-subtle' : 'hover:bg-surface-2',
                  )}
                >
                  <td className="h-(--row-h) border-b border-line px-3">
                    <span className="flex items-center gap-2">
                      <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                      <span className="truncate">{item.title}</span>
                      {item.type === 'folder' ? (
                        <ChevronRight className="size-3.5 text-fg-muted" aria-hidden />
                      ) : null}
                    </span>
                  </td>
                  <td className="tabular border-b border-line px-3 text-right text-xs text-fg-secondary">
                    {typeof item.meta.size === 'number'
                      ? formatFileSize(item.meta.size, { locale })
                      : '—'}
                  </td>
                  <td className="border-b border-line px-3 text-xs text-fg-secondary">
                    {formatRelativeTime(item.updatedAt, { locale })}
                  </td>
                  <td className="border-b border-line px-3 text-xs text-fg-secondary">
                    {typeof item.meta.version === 'number' ? (
                      <Badge size="sm">v{item.meta.version}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="border-b border-line px-3">
                    <span className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <IconButton
                        label={t('common.actions.share')}
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          setShareTarget(item)
                        }}
                      >
                        <Share2 className="size-3.5" />
                      </IconButton>
                      {item.type === 'file' ? (
                        <IconButton
                          label={t('common.actions.download')}
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            void downloadFile(item.id)
                          }}
                        >
                          <Download className="size-3.5" />
                        </IconButton>
                      ) : null}
                      <IconButton
                        label={t('common.actions.delete')}
                        size="sm"
                        variant="danger"
                        onClick={(event) => {
                          event.stopPropagation()
                          setDeleteTarget(item)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
            {[...folders, ...files].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => openObject(item)}
                onDoubleClick={() => openObject(item, true)}
                className="flex flex-col items-start gap-2 rounded-md border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
              >
                <ObjectIcon type={item.type} className="size-8 text-fg-muted" />
                <span className="line-clamp-2 text-sm text-fg">{item.title}</span>
                <span className="text-2xs text-fg-muted">
                  {typeof item.meta.size === 'number'
                    ? formatFileSize(item.meta.size, { locale })
                    : t('objects.types.folder')}
                </span>
              </button>
            ))}
          </div>
        )}
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

const SPACE_ORDER: Record<string, number> = { org: 0, team: 1, unit: 2, personal: 3 }

/** Порядок пространств: общее → команды → подразделения → личное. */
function orderSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort(
    (a, b) =>
      (SPACE_ORDER[a.kind] ?? 9) - (SPACE_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name, 'ru'),
  )
}

async function downloadFile(fileId: string): Promise<void> {
  const result = await http.get<{ url: string; name: string }>(`/files/${fileId}/download`)
  const link = document.createElement('a')
  link.href = result.url
  link.download = result.name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}
