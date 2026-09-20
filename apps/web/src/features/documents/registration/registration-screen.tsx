import type { Confidentiality, DocumentRecord, DocumentTypeRecord } from '@kchs/contracts'
import {
  Button,
  Callout,
  EmptyState,
  FileDropzone,
  PanelToolbar,
  ProgressBar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Save, Stamp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { uploadFile } from '~/features/files/upload.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import {
  type CardValue,
  cardPayload,
  emptyCardValue,
  RequisitesForm,
} from '../card/requisites-form.js'
import { documentKeys, documentTypesQuery } from '../queries.js'
import { ScanViewer } from '../scan-viewer.js'
import { errorText, fieldErrors, localToday } from '../status.js'
import {
  assistOverlay,
  RegistrationAssist,
  type RegistrationAssistProps,
} from './registration-assist.js'

interface Draft {
  id: string
  spaceId: string
}

/** Новая карточка входящего: поступил сегодня, если не указано иное. */
const blankCard = (confidentiality: Confidentiality): CardValue => ({
  ...emptyCardValue(confidentiality),
  receivedDate: localToday(),
})

/**
 * Регистрация входящего (03-screens.md §12, 08-documents.md §5): слева скан с
 * масштабом, справа карточка; внизу — «Зарегистрировать». Черновик создаётся с
 * первым сканом или сохранением; номер выдаёт журнал типа в транзакции
 * регистрации. Помощник ИИ — слот `registration-assist.tsx` (вторая волна).
 */
export function RegistrationScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: me } = useQuery(meQuery())
  const { data: types = [], isLoading } = useQuery(documentTypesQuery())
  const incoming = useMemo(() => types.filter((type) => type.direction === 'incoming'), [types])

  const [typeId, setTypeId] = useState<string>('')
  const type = incoming.find((item) => item.id === typeId) ?? incoming[0] ?? null
  const [draft, setDraft] = useState<Draft | null>(null)
  const [value, setValue] = useState<CardValue>(() => blankCard('internal'))
  const [scanFileId, setScanFileId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [activeField, setActiveField] = useState<string | null>(null)

  useEffect(() => {
    if (!typeId && incoming[0]) setTypeId(incoming[0].id)
  }, [typeId, incoming])
  useEffect(() => {
    if (type && !draft)
      setValue((current) => ({ ...current, confidentiality: type.defaultConfidentiality }))
  }, [type, draft])

  const reset = () => {
    setDraft(null)
    setScanFileId(null)
    setErrors({})
    setFailure(null)
    setValue(blankCard(type?.defaultConfidentiality ?? 'internal'))
  }

  /** Черновик — с первым сканом или сохранением: к нему прикрепляются файлы. */
  const ensureDraft = async (current: DocumentTypeRecord): Promise<Draft> => {
    if (draft) return draft
    const created = await http.post<{ id: string }>('/documents', {
      typeId: current.id,
      ...cardPayload(value),
    })
    const record = await http.get<DocumentRecord>(`/documents/${created.id}`)
    const next = { id: record.id, spaceId: record.spaceId }
    setDraft(next)
    return next
  }

  const attach = useMutation({
    mutationFn: async (file: File) => {
      if (!type) return
      const target = await ensureDraft(type)
      setProgress(0)
      const uploaded = await uploadFile({
        file,
        spaceId: target.spaceId,
        attachToObjectId: target.id,
        onProgress: setProgress,
      })
      await http.post(`/documents/${target.id}/versions`, { mainFileId: uploaded.id })
      setScanFileId(uploaded.id)
    },
    onSettled: () => setProgress(null),
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (!type) return
      const target = await ensureDraft(type)
      await http.patch(`/documents/${target.id}`, cardPayload(value))
    },
    onSuccess: () => {
      setErrors({})
      toast.show({ title: t('documents.register.draftSaved'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['objects'] })
    },
    onError: (error) => {
      setErrors(fieldErrors(error))
      toast.error(errorText(error, t('errors.unknown')))
    },
  })

  const register = useMutation({
    mutationFn: async () => {
      if (!type) throw new Error(t('documents.register.noType'))
      const target = await ensureDraft(type)
      await http.patch(`/documents/${target.id}`, cardPayload(value))
      return http.post<DocumentRecord>(`/documents/${target.id}/register`, {})
    },
    onSuccess: (record) => {
      toast.show({
        title: t('documents.register.done', { number: record.regNumber ?? '' }),
        tone: 'success',
      })
      void client.invalidateQueries({ queryKey: ['objects'] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      openTab({
        kind: 'object',
        objectId: record.id,
        objectType: 'document',
        title: `${record.regNumber ?? ''} · ${record.subject}`,
        mode: 'background',
      })
      reset()
    },
    onError: (error) => {
      setErrors(fieldErrors(error))
      setFailure(
        error instanceof ApiError && error.status === 400
          ? t('documents.register.fixFields')
          : errorText(error, t('errors.unknown')),
      )
    },
  })

  const assist: RegistrationAssistProps = {
    documentId: draft?.id ?? null,
    scanFileId,
    value,
    onChange: setValue,
    activeField,
    typeId: type?.id ?? '',
    onTypeChange: setTypeId,
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }
  if (!type) {
    return <EmptyState icon={<FileText />} title={t('documents.register.noType')} />
  }

  return (
    <section aria-label={t('documents.register.title')} className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <h1 className="text-sm font-semibold text-fg">{t('documents.register.title')}</h1>
            <Select
              value={type.id}
              onValueChange={(next) => {
                setTypeId(next)
                reset()
              }}
              disabled={Boolean(draft)}
            >
              <SelectTrigger aria-label={t('documents.fields.type')} className="h-7 w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {incoming.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name[locale] ?? item.name.ru}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        right={
          type.journalName ? (
            <span className="text-xs text-fg-muted">
              {t('documents.register.journal', { name: type.journalName })}
            </span>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <div className="flex min-h-[420px] flex-col border-r border-line">
          {scanFileId ? (
            <ScanViewer fileId={scanFileId} overlay={(page) => assistOverlay(assist, page)} />
          ) : (
            <div className="flex flex-1 flex-col justify-center gap-3 p-6">
              <FileDropzone
                multiple={false}
                accept="application/pdf,image/*,.doc,.docx,.odt,.rtf"
                onFiles={(files) => files[0] && attach.mutate(files[0])}
                disabled={attach.isPending}
                label={t('documents.register.dropScan')}
                hint={t('documents.register.dropScanHint')}
              />
              {progress !== null ? (
                <ProgressBar value={progress} label={t('documents.versions.uploading')} />
              ) : null}
            </div>
          )}
        </div>
        <div
          className="min-h-0 overflow-y-auto bg-canvas p-5"
          onFocusCapture={(event) => {
            const key = (event.target as HTMLElement)
              .closest('[data-field-key]')
              ?.getAttribute('data-field-key')
            setActiveField(key ?? null)
          }}
        >
          <div className="mx-auto flex max-w-[640px] flex-col gap-4">
            <RegistrationAssist {...assist} />
            {failure ? <Callout tone="danger">{failure}</Callout> : null}
            <RequisitesForm
              type={{
                id: type.id,
                key: type.key,
                name: type.name,
                direction: type.direction,
                settings: type.settings,
                cardSchema: type.cardSchema,
                confidentialityAllowed: type.confidentialityAllowed,
                journalId: type.numbering.journalId,
              }}
              value={value}
              onChange={setValue}
              errors={errors}
              canCreateCorrespondent={me?.capabilities.includes('documents.register') ?? false}
            />
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface px-4 py-2.5">
        {type.settings.requireScan && !scanFileId ? (
          <span className="mr-auto text-xs text-fg-muted">
            {t('documents.register.scanRequired')}
          </span>
        ) : null}
        <Button
          variant="secondary"
          icon={<Save className="size-3.5" />}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t('documents.register.saveDraft')}
        </Button>
        <Button
          variant="primary"
          icon={<Stamp className="size-3.5" />}
          loading={register.isPending}
          disabled={type.settings.requireScan && !scanFileId}
          onClick={() => {
            setFailure(null)
            register.mutate()
          }}
        >
          {t('documents.actions.register')}
        </Button>
      </footer>
    </section>
  )
}
