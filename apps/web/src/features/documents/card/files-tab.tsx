import type { DocumentFileRef, DocumentVersionRecord, OfficeEditing } from '@kchs/contracts'
import { formatDateTime, formatFileSize } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  cn,
  Field,
  FileDropzone,
  IconButton,
  Input,
  ObjectIcon,
  ProgressBar,
  Skeleton,
  Tooltip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, GitCompare, PenLine } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import {
  editorNames,
  officeEditable,
  useOfficeConfigured,
  useOfficeEditing,
  useOpenOfficeEditor,
} from '~/features/files/office.js'
import { uploadFile } from '~/features/files/upload.js'
import { useFileDownload } from '~/features/files/use-file-download.js'
import { http } from '~/shared/api/client.js'
import { CompareDialog } from '../print/compare-dialog.js'
import { RendersSection } from '../print/renders-section.js'
import { documentVersionsQuery } from '../queries.js'
import { ScanViewer } from '../scan-viewer.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'

/** Файлы версии, которые открывает редактор: основной и приложения. */
function editableFiles(version: DocumentVersionRecord | null | undefined): DocumentFileRef[] {
  if (!version) return []
  return [version.mainFile, ...version.attachments].filter(
    (file): file is DocumentFileRef => file !== null && officeEditable(file),
  )
}

/**
 * «Файл правят» в шапке карточки (N70): файл текущей версии открыт в редакторе —
 * видно с любой вкладки, кто именно, — в подсказке.
 */
export function OfficeEditingBadge() {
  const t = useT()
  const { document } = useDocument()
  const files = editableFiles(document.currentVersion)
  const editing = useOfficeEditing(files.map((file) => file.id))
  const first = files.map((file) => editing.get(file.id)).find(Boolean)
  if (!first) return null
  return (
    <Tooltip content={t('files.office.editingNow', { names: editorNames(first) })}>
      <Badge size="sm" tone="warning">
        <PenLine className="size-2.5" aria-hidden />
        {t('files.office.editingFile')}
      </Badge>
    </Tooltip>
  )
}

/**
 * Вкладка «Файлы и версии» (03-screens.md §12): PDF-представление выбранной
 * версии рядом со списком версий; новая версия — основной файл и приложения,
 * загруженные вложениями документа.
 */
export function FilesTab() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { document, refresh } = useDocument()
  const { data: versions = [], isLoading } = useQuery(documentVersionsQuery(document.id))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find((version) => version.id === selectedId) ?? versions[0] ?? null
  const shown = selected?.pdfFile ?? selected?.mainFile ?? null
  const [comparing, setComparing] = useState(false)

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
      <ScanViewer fileId={shown?.id ?? null} className="min-h-[420px] border-r border-line" />
      <aside
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        aria-label={t('documents.versions.title')}
      >
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-fg">
            {t('documents.versions.title')}
          </h2>
          {versions.length >= 2 ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<GitCompare className="size-3.5" />}
              onClick={() => setComparing(true)}
            >
              {t('documents.compare.open')}
            </Button>
          ) : null}
        </div>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : versions.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('documents.versions.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {versions.map((version) => (
              <li key={version.id}>
                <VersionItem
                  version={version}
                  current={version.id === document.currentVersion?.id}
                  selected={version.id === selected?.id}
                  onSelect={() => setSelectedId(version.id)}
                  locale={locale}
                />
              </li>
            ))}
          </ol>
        )}
        {document.can.addVersion ? <NewVersion onDone={refresh} /> : null}
        <RendersSection document={document} />
      </aside>
      {comparing ? (
        <CompareDialog
          documentId={document.id}
          versions={versions}
          onClose={() => setComparing(false)}
        />
      ) : null}
    </div>
  )
}

function VersionItem({
  version,
  current,
  selected,
  onSelect,
  locale,
}: {
  version: DocumentVersionRecord
  current: boolean
  selected: boolean
  onSelect: () => void
  locale: 'ru' | 'tg' | 'en'
}) {
  const t = useT()
  const download = useFileDownload()
  // Основной файл версии — обычно DOCX: его правят в редакторе, и правка
  // ложится новой версией самого файла (ADR-0112)
  const openOffice = useOpenOfficeEditor()
  const officeReady = useOfficeConfigured()
  const editing = useOfficeEditing(editableFiles(version).map((file) => file.id))
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3',
        selected ? 'border-accent bg-accent-subtle' : 'border-line bg-surface',
      )}
    >
      <button type="button" onClick={onSelect} className="flex items-center gap-2 text-left">
        <span className="text-sm font-medium text-fg">
          {t('documents.versions.number', { number: version.number })}
        </span>
        {current ? (
          <Badge tone="accent" size="sm">
            {t('documents.versions.current')}
          </Badge>
        ) : null}
        {version.isFinal ? <Badge size="sm">{t('documents.versions.final')}</Badge> : null}
        <Badge
          size="sm"
          tone={
            version.pdfStatus === 'ready'
              ? 'success'
              : version.pdfStatus === 'failed'
                ? 'danger'
                : 'neutral'
          }
          className="ml-auto"
        >
          {t(`documents.versions.pdf.${version.pdfStatus}`)}
        </Badge>
      </button>
      <p className="text-xs text-fg-muted">
        {version.createdBy?.displayName ?? '—'} · {formatDateTime(version.createdAt, { locale })}
      </p>
      {version.note ? <p className="text-xs text-fg-secondary">{version.note}</p> : null}
      <ul className="flex flex-col gap-1">
        {[version.mainFile, ...version.attachments]
          .filter((file): file is DocumentFileRef => file !== null)
          .map((file, index) => (
            <li key={file.id} className="flex items-center gap-2 text-xs">
              <ObjectIcon type="file" className="size-3.5 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate text-fg" title={file.name}>
                {index === 0 ? t('documents.versions.main') : t('documents.versions.attachment')}:{' '}
                {file.name}
              </span>
              {editing.get(file.id) ? (
                <Tooltip
                  content={t('files.office.editingNow', {
                    names: editorNames(editing.get(file.id) as OfficeEditing),
                  })}
                >
                  <Badge size="sm" tone="warning">
                    {t('files.office.editing')}
                  </Badge>
                </Tooltip>
              ) : null}
              <span className="shrink-0 tabular text-fg-muted">{formatFileSize(file.size)}</span>
              {officeReady && officeEditable(file) ? (
                <Tooltip content={t('files.office.open')}>
                  <IconButton
                    size="sm"
                    label={t('files.office.open')}
                    onClick={() => openOffice({ id: file.id, name: file.name })}
                  >
                    <PenLine className="size-3.5" />
                  </IconButton>
                </Tooltip>
              ) : null}
              <Tooltip content={t('common.actions.download')}>
                <IconButton
                  size="sm"
                  label={t('common.actions.download')}
                  onClick={() => download.mutate({ fileId: file.id })}
                >
                  <Download className="size-3.5" />
                </IconButton>
              </Tooltip>
            </li>
          ))}
      </ul>
      {version.hash ? (
        <p className="truncate font-mono text-2xs text-fg-muted" title={version.hash}>
          SHA-256 {version.hash.slice(0, 16)}…
        </p>
      ) : null}
    </div>
  )
}

/** Новая версия: основной файл (обязателен) и приложения, примечание. */
function NewVersion({ onDone }: { onDone: () => void }) {
  const t = useT()
  const toast = useToast()
  const noteId = useId()
  const { document } = useDocument()
  // Пока файл правят в редакторе, новую версию загрузить можно, но об этом стоит знать (N70)
  const currentFiles = editableFiles(document.currentVersion)
  const editing = useOfficeEditing(currentFiles.map((file) => file.id))
  const busy = currentFiles
    .map((file) => ({ file, editing: editing.get(file.id) }))
    .find((item) => item.editing !== undefined)
  const [main, setMain] = useState<File | null>(null)
  const [attachments, setAttachments] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)

  const add = useMutation({
    mutationFn: async () => {
      if (!main) return
      const files = [main, ...attachments]
      const uploaded: string[] = []
      for (const [index, file] of files.entries()) {
        const record = await uploadFile({
          file,
          spaceId: document.spaceId,
          attachToObjectId: document.id,
          onProgress: (value) => setProgress((index + value) / files.length),
        })
        uploaded.push(record.id)
      }
      await http.post(`/documents/${document.id}/versions`, {
        mainFileId: uploaded[0],
        attachmentIds: uploaded.slice(1),
        note: note.trim() || null,
      })
    },
    onSuccess: () => {
      setMain(null)
      setAttachments([])
      setNote('')
      setProgress(null)
      toast.show({ title: t('documents.versions.added'), tone: 'success' })
      onDone()
    },
    onError: (error) => {
      setProgress(null)
      toast.error(errorText(error, t('errors.unknown')))
    },
  })

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.versions.new')}
      </h3>
      {busy?.editing ? (
        <Callout tone="warning">
          {t('files.office.editingUpload', {
            name: busy.file.name,
            names: editorNames(busy.editing),
          })}
        </Callout>
      ) : null}
      <FileDropzone
        compact
        multiple={false}
        onFiles={(files) => setMain(files[0] ?? null)}
        label={main ? main.name : t('documents.versions.mainDrop')}
      />
      <FileDropzone
        compact
        onFiles={(files) => setAttachments((current) => [...current, ...files])}
        label={
          attachments.length > 0
            ? t('documents.versions.attachmentsCount', { count: attachments.length })
            : t('documents.versions.attachmentsDrop')
        }
      />
      <Field label={t('documents.versions.note')} htmlFor={noteId}>
        <Input
          id={noteId}
          value={note}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {progress !== null ? (
        <ProgressBar value={progress} label={t('documents.versions.uploading')} />
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={!main}
        loading={add.isPending}
        onClick={() => add.mutate()}
      >
        {t('documents.versions.add')}
      </Button>
    </section>
  )
}
