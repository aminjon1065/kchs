import type { FileVersion } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  FileDropzone,
  Input,
  ProgressBar,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { keys } from '~/shared/api/queries.js'
import { uploadFile } from './upload.js'

/**
 * Новая версия файла с примечанием — что изменилось (ADR-0151). Прерванная
 * загрузка продолжается: повторный «Загрузить» того же файла докачивает части.
 */
export function NewVersionDialog({
  fileId,
  spaceId,
  onClose,
}: {
  fileId: string
  spaceId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const noteId = useId()
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) return
      setError(null)
      await uploadFile({ file, spaceId, fileId, note, onProgress: setProgress })
    },
    onSuccess: () => {
      toast.show({ title: t('files.versions.uploaded'), tone: 'success' })
      void client.invalidateQueries({ queryKey: keys.file(fileId) })
      void client.invalidateQueries({ queryKey: keys.fileVersions(fileId) })
      void client.invalidateQueries({ queryKey: keys.object(fileId) })
      onClose()
    },
    onError: (err) => {
      setProgress(null)
      setError(err instanceof Error ? err.message : t('files.upload.failed'))
    },
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('files.versions.upload')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!file}
              loading={upload.isPending}
              onClick={() => upload.mutate()}
            >
              {t('common.actions.upload')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="warning">{error}</Callout> : null}
          <FileDropzone
            compact
            multiple={false}
            onFiles={(files) => setFile(files[0] ?? null)}
            label={file ? file.name : t('files.versions.drop')}
          />
          <Field
            label={t('files.versions.note')}
            hint={t('files.versions.noteHint')}
            htmlFor={noteId}
          >
            <Input
              id={noteId}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          {progress !== null ? (
            <ProgressBar
              value={progress}
              label={t('files.upload.uploading', { name: file?.name ?? '' })}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Откат к прежней версии: она становится новой текущей с примечанием и причиной. */
export function RestoreVersionDialog({
  fileId,
  version,
  onClose,
}: {
  fileId: string
  version: FileVersion
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const noteId = useId()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const restore = useMutation({
    mutationFn: () =>
      http.post(`/files/${fileId}/versions/${version.id}/restore`, {
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      toast.show({
        title: t('files.versions.restored', { number: version.number }),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: keys.file(fileId) })
      void client.invalidateQueries({ queryKey: keys.fileVersions(fileId) })
      void client.invalidateQueries({ queryKey: keys.object(fileId) })
      onClose()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('errors.unknown')),
  })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={t('files.versions.restoreTitle', { number: version.number })}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={restore.isPending} onClick={() => restore.mutate()}>
              {t('files.versions.restore')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <p className="text-sm text-fg-secondary">
            {t('files.versions.restoreHint', { number: version.number })}
          </p>
          <Field label={t('files.versions.restoreReason')} htmlFor={noteId}>
            <Input
              id={noteId}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
