import type { FileVersion } from '@kchs/contracts'
import { formatDateTime, formatFileSize, formatRelativeTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  IconButton,
  InlineEdit,
  KeyValueList,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, History, PenLine, RotateCcw, Share2, Trash2, Upload } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { FilePreview } from '~/features/files/file-preview.js'
import {
  editorNames,
  useOfficeAvailable,
  useOfficeEditing,
  useOpenOfficeEditor,
} from '~/features/files/office.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { NewVersionDialog, RestoreVersionDialog } from '~/features/files/version-dialogs.js'
import { http } from '~/shared/api/client.js'
import { fileQuery, fileVersionsQuery, keys, objectQuery } from '~/shared/api/queries.js'
import { PresenceAvatars } from './presence-avatars.js'

export function FileView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const fileDownload = useFileDownload()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const closeTab = useWorkspace((s) => s.closeTab)

  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [newVersionOpen, setNewVersionOpen] = useState(false)
  const [restoring, setRestoring] = useState<FileVersion | null>(null)

  const { data: object } = useQuery(objectQuery(objectId))
  const { data: file, isLoading } = useQuery(fileQuery(objectId))
  const { data: versions = [] } = useQuery(fileVersionsQuery(objectId))
  // Совместное редактирование офисных файлов (ADR-0112): читателю — просмотр,
  // редактору — правка; режим определяет сервер по правам на файл
  const officeAvailable = useOfficeAvailable(file?.name)
  const openOffice = useOpenOfficeEditor()
  // Файл сейчас правят в редакторе (N70): видно до того, как загрузить свою версию
  const editing = useOfficeEditing(officeAvailable ? [objectId] : []).get(objectId)

  const rename = useMutation({
    mutationFn: (title: string) => http.patch(`/objects/${objectId}`, { title }),
    onSuccess: (_result, title) => {
      setTabTitle(tabId, title)
      void client.invalidateQueries({ queryKey: keys.object(objectId) })
      void client.invalidateQueries({ queryKey: keys.file(objectId) })
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
  if (!file) return <EmptyState title={t('common.states.notFound')} />

  const download = (versionId?: string) =>
    fileDownload.mutate({ fileId: objectId, ...(versionId ? { versionId } : {}) })

  const canEdit = object ? ['edit', 'manage', 'owner'].includes(object.level) : false

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="file" className="size-4 shrink-0 text-fg-muted" />
            <InlineEdit
              value={file.name}
              disabled={!canEdit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('common.labels.name')}
            />
            <Badge size="sm">v{file.versionNumber}</Badge>
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {officeAvailable ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<PenLine className="size-3.5" />}
                onClick={() => openOffice({ id: objectId, name: file.name })}
              >
                {t('files.office.open')}
              </Button>
            ) : null}
            <Button
              variant={officeAvailable ? 'ghost' : 'secondary'}
              size="sm"
              icon={<Download className="size-3.5" />}
              onClick={() => download()}
            >
              {t('common.actions.download')}
            </Button>
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<Upload className="size-3.5" />}
                onClick={() => setNewVersionOpen(true)}
              >
                {t('files.versions.upload')}
              </Button>
            ) : null}
            <IconButton label={t('common.actions.share')} onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" />
            </IconButton>
            {canEdit ? (
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

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0 px-2.5">
          <TabsTrigger value="overview">{t('objects.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="versions" count={versions.length}>
            {t('files.versions.title')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto flex max-w-[760px] flex-col gap-4">
            {editing ? (
              <Callout tone="info">
                {t('files.office.editingNow', { names: editorNames(editing) })}
              </Callout>
            ) : null}
            <Card>
              <FilePreview fileId={objectId} />
            </Card>

            <Card title={t('objects.properties')}>
              <KeyValueList
                items={[
                  {
                    key: 'size',
                    label: t('common.labels.size'),
                    value: formatFileSize(file.size, { locale }),
                  },
                  {
                    key: 'mime',
                    label: t('common.labels.type'),
                    value: <code className="font-mono text-xs">{file.mime}</code>,
                  },
                  {
                    key: 'owner',
                    label: t('common.labels.owner'),
                    value: file.owner?.displayName ?? '—',
                  },
                  {
                    key: 'created',
                    label: t('common.labels.createdAt'),
                    value: formatDateTime(file.createdAt, { locale }),
                  },
                  {
                    key: 'updated',
                    label: t('common.labels.updatedAt'),
                    value: formatRelativeTime(file.updatedAt, { locale }),
                  },
                  {
                    key: 'checksum',
                    label: t('files.checksum'),
                    value: <code className="font-mono text-2xs">{file.checksum ?? '—'}</code>,
                  },
                ]}
              />
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="versions" className="min-h-0 flex-1 overflow-y-auto bg-canvas p-5">
          <div className="mx-auto max-w-[760px]">
            <Card title={t('files.versions.title')} padded={false}>
              <ul className="divide-y divide-line">
                {versions.map((version) => (
                  <li key={version.id} className="flex items-center gap-3 px-4 py-2.5">
                    <History className="size-4 shrink-0 text-fg-muted" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm text-fg">
                        {t('files.versions.number', { number: version.number })}
                        {version.number === file.versionNumber ? (
                          <Badge tone="accent" size="sm">
                            {t('files.versions.current')}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="block text-xs text-fg-muted">
                        {version.createdBy?.displayName ?? '—'} ·{' '}
                        {formatRelativeTime(version.createdAt, { locale })} ·{' '}
                        {formatFileSize(version.size, { locale })}
                      </span>
                      {version.note ? (
                        <span className="block text-xs text-fg-secondary">{version.note}</span>
                      ) : null}
                    </span>
                    {canEdit && version.number !== file.versionNumber ? (
                      <IconButton
                        label={t('files.versions.restoreFor', { number: version.number })}
                        size="sm"
                        onClick={() => setRestoring(version)}
                      >
                        <RotateCcw className="size-3.5" />
                      </IconButton>
                    ) : null}
                    <IconButton
                      label={t('common.actions.download')}
                      size="sm"
                      onClick={() => download(version.id)}
                    >
                      <Download className="size-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <ShareDialog
        objectId={objectId}
        title={file.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
      {newVersionOpen && object?.spaceId ? (
        <NewVersionDialog
          fileId={objectId}
          spaceId={object.spaceId}
          onClose={() => setNewVersionOpen(false)}
        />
      ) : null}
      {restoring ? (
        <RestoreVersionDialog
          fileId={objectId}
          version={restoring}
          onClose={() => setRestoring(null)}
        />
      ) : null}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('objects.deleteConfirm', { title: file.name })}
        description={t('objects.trash.hint')}
        confirmLabel={t('common.actions.delete')}
        onConfirm={() => {
          trash.mutate()
          setDeleteOpen(false)
        }}
      />
    </div>
  )
}
