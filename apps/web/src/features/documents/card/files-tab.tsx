import type { DocumentFileRef, DocumentVersionRecord } from '@kchs/contracts'
import { formatDateTime, formatFileSize } from '@kchs/fields'
import {
  Badge,
  Button,
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
import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { uploadFile } from '~/features/files/upload.js'
import { http } from '~/shared/api/client.js'
import { documentVersionsQuery } from '../queries.js'
import { ScanViewer } from '../scan-viewer.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'

async function download(file: DocumentFileRef): Promise<void> {
  const result = await http.get<{ url: string; name: string }>(`/files/${file.id}/download`)
  const link = window.document.createElement('a')
  link.href = result.url
  link.download = result.name
  window.document.body.appendChild(link)
  link.click()
  link.remove()
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

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
      <ScanViewer fileId={shown?.id ?? null} className="min-h-[420px] border-r border-line" />
      <aside
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
        aria-label={t('documents.versions.title')}
      >
        <h2 className="text-sm font-semibold text-fg">{t('documents.versions.title')}</h2>
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
      </aside>
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
              <span className="shrink-0 tabular text-fg-muted">{formatFileSize(file.size)}</span>
              <Tooltip content={t('common.actions.download')}>
                <IconButton
                  size="sm"
                  label={t('common.actions.download')}
                  onClick={() => void download(file)}
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
