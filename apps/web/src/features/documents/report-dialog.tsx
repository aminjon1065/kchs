import { DOCUMENT_PHOTO_MAX_PER_DOCUMENT } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  type FormValues,
  IconButton,
  SchemaForm,
  Skeleton,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useFieldControls } from '~/features/data/field-controls.js'
import { meQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import {
  compressPhoto,
  forgetPhotos,
  localPhoto,
  PhotoFormatError,
  saveLocalPhoto,
} from '~/shared/offline/photos.js'
import {
  type DocumentCreateEntry,
  discardOfflineEntry,
  OFFLINE_AWARE,
  submitDocument,
  useOfflineQueue,
} from '~/shared/offline/queue.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { documentKeys, documentTypesQuery } from './queries.js'
import { errorText } from './status.js'

/** Тип «Донесение» стартового набора; реквизиты ЧС ему добавляет пакет ЧС. */
export const REPORT_TYPE_KEY = 'situation_report'

/**
 * «Донесение» (ADR-0212): тема, реквизиты типа и снимки с телефона — черновик документа
 * автора. Ключ создания выдаётся при открытии диалога: без сети донесение ложится в
 * очередь устройства и уходит само тем же ключом, поэтому повтор не создаёт второго
 * документа, а снимки — второго файла.
 */
export function ReportDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const subjectId = useId()
  const input = useRef<HTMLInputElement>(null)
  const { data: me } = useQuery(meQuery())
  const { data: types = [], isLoading } = useQuery(documentTypesQuery())
  const type = types.find((item) => item.key === REPORT_TYPE_KEY) ?? null
  const renderControl = useFieldControls(type?.cardSchema.fields ?? [])
  const userId = me?.user.id ?? null
  const [clientKey] = useState(() => crypto.randomUUID())
  const [subject, setSubject] = useState('')
  const [fields, setFields] = useState<FormValues>({})
  const [photos, setPhotos] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const sent = useRef(false)

  const send = useMutation({
    ...OFFLINE_AWARE,
    mutationFn: async (values: FormValues) => {
      if (!type || !userId) throw new Error('type')
      const title = subject.trim()
      return submitDocument({
        userId,
        title: title || t('documents.report.untitled'),
        body: { typeId: type.id, subject: title, fields: values, clientKey },
        photos,
      })
    },
    onSuccess: (outcome) => {
      sent.current = true
      void client.invalidateQueries({ queryKey: documentKeys.all })
      onClose()
      if (outcome.queued) {
        toast.show({ title: t('documents.report.queued') })
        return
      }
      toast.success(t('documents.report.created'))
      openTab({
        kind: 'object',
        objectId: outcome.id,
        objectType: 'document',
        title: subject.trim() || t('documents.report.untitled'),
        mode: 'permanent',
      })
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  // Закрыли, не отправив, — снимки с устройства убрать
  const cancel = () => {
    if (!sent.current) void forgetPhotos(photos)
    onClose()
  }

  const take = async (files: FileList) => {
    if (!userId) return
    setBusy(true)
    try {
      const room = DOCUMENT_PHOTO_MAX_PER_DOCUMENT - photos.length
      if (files.length > room) {
        toast.error(t('documents.report.photoLimit', { count: DOCUMENT_PHOTO_MAX_PER_DOCUMENT }))
      }
      const taken: string[] = []
      for (const file of [...files].slice(0, Math.max(room, 0))) {
        const blob = await compressPhoto(file)
        taken.push((await saveLocalPhoto({ userId, fieldKey: 'report', blob })).id)
      }
      setPhotos((current) => [...current, ...taken])
    } catch (error) {
      toast.error(
        error instanceof PhotoFormatError && error.message === 'size'
          ? t('documents.report.photoSize')
          : t('documents.report.photoFormat'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && cancel()}>
      <DialogContent
        title={t('documents.report.title')}
        size="md"
        footer={
          <Button variant="secondary" onClick={cancel}>
            {t('common.actions.cancel')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {isLoading ? <Skeleton className="h-24" /> : null}
          {!isLoading && !type ? (
            <Callout tone="warning">{t('documents.report.unavailable')}</Callout>
          ) : null}
          {type ? (
            <>
              <Field label={t('documents.report.subject')} htmlFor={subjectId}>
                <Textarea
                  id={subjectId}
                  autoFocus
                  rows={2}
                  maxLength={1000}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              </Field>
              <Field label={t('documents.report.photos')}>
                <div className="flex flex-wrap items-center gap-2">
                  {photos.map((id) => (
                    <div key={id} className="flex items-start gap-1">
                      <ReportPhoto id={id} userId={userId} />
                      <IconButton
                        type="button"
                        size="sm"
                        label={t('documents.report.removePhoto')}
                        onClick={() => {
                          setPhotos((current) => current.filter((item) => item !== id))
                          void forgetPhotos([id])
                        }}
                      >
                        <X className="size-3.5" aria-hidden />
                      </IconButton>
                    </div>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    icon={<Camera className="size-3.5" />}
                    loading={busy}
                    disabled={photos.length >= DOCUMENT_PHOTO_MAX_PER_DOCUMENT}
                    onClick={() => input.current?.click()}
                  >
                    {t('documents.report.addPhoto')}
                  </Button>
                  {/* Без `capture`: телефон предлагает и камеру, и галерею */}
                  <input
                    ref={input}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    aria-label={t('documents.report.addPhoto')}
                    onChange={(event) => {
                      const files = event.target.files
                      if (files && files.length > 0) void take(files)
                      event.target.value = ''
                    }}
                  />
                </div>
              </Field>
              <SchemaForm
                schema={{ fields: type.cardSchema.fields }}
                values={fields}
                onChange={setFields}
                renderControl={renderControl}
                onSubmit={(values) => send.mutate(values)}
                submitLabel={t('documents.report.send')}
              />
              <p className="text-xs text-fg-muted">{t('documents.report.hint')}</p>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Миниатюра снимка донесения с устройства. */
function ReportPhoto({ id, userId }: { id: string; userId: string | null }) {
  const t = useT()
  const { data: photo, isLoading } = useQuery({
    ...OFFLINE_AWARE,
    queryKey: ['documents', 'report-photo', id, userId],
    queryFn: async () => (userId ? await localPhoto(id, userId) : null),
  })
  const [url, setUrl] = useState<string | null>(null)
  const blob = photo?.blob ?? null
  useEffect(() => {
    if (!blob) return
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
      setUrl(null)
    }
  }, [blob])
  if (isLoading || !url) return <Skeleton className="h-16 w-20" />
  return (
    <img
      src={url}
      alt={t('documents.report.photoAlt')}
      className="h-16 w-20 rounded-sm border border-line bg-surface-2 object-cover"
    />
  )
}

/**
 * Донесения вошедшего, ждущие сети или решения человека: отказ по существу показывается
 * с причиной и кнопкой «Убрать из очереди».
 */
export function QueuedReports() {
  const t = useT()
  const entries = useOfflineQueue().filter(
    (entry): entry is DocumentCreateEntry => entry.kind === 'document.create',
  )
  if (entries.length === 0) return null
  return (
    <div className="flex flex-col gap-2 border-b border-line p-3">
      {entries.map((entry) => (
        <Callout
          key={entry.id}
          tone={entry.state === 'failed' ? 'danger' : 'info'}
          action={
            entry.state === 'failed' ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void discardOfflineEntry(entry.id)}
              >
                {t('documents.report.discard')}
              </Button>
            ) : undefined
          }
        >
          {entry.state === 'failed'
            ? t('documents.report.failed', { title: entry.title, error: entry.error ?? '' })
            : t('documents.report.pending', { title: entry.title })}
        </Callout>
      ))}
    </div>
  )
}
