import {
  type CorrespondentRef,
  DELIVERY_METHODS,
  type DeliveryMethod,
  type DocumentRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  RadioGroup,
  RadioItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Briefcase, Reply, Send } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { CorrespondentPicker } from '../correspondent-picker.js'
import { caseSuggestionsQuery, documentKeys } from '../queries.js'
import { errorText, localToday } from '../status.js'
import { useDocument } from './document-context.js'

/**
 * Делопроизводство в контекст-панели карточки (08-documents.md §5, §11, §12;
 * ADR-0086): «Ответить» на входящий исходящим со связью «в ответ на»,
 * «Отметить отправку» исходящего, «Подшить в дело» исполненный документ.
 * Права и статусы считает сервер (`document.can`).
 */
export function DocumentOfficeActions() {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const { document, refresh } = useDocument()
  const [dialog, setDialog] = useState<'dispatch' | 'file' | null>(null)

  const reply = useMutation({
    mutationFn: () => http.post<{ id: string }>(`/documents/${document.id}/reply`, {}),
    onSuccess: ({ id }) => {
      toast.show({ title: t('documents.reply.created'), tone: 'success' })
      refresh()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'document',
        title: document.subject || t('documents.draft'),
        mode: 'permanent',
      })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  const done = (record: DocumentRecord) => {
    client.setQueryData(documentKeys.document(record.id), record)
    setDialog(null)
    refresh()
  }

  if (!document.can.reply && !document.can.dispatch && !document.can.file) return null
  return (
    <section
      aria-label={t('documents.office.title')}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.office.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        {document.can.reply ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Reply className="size-3.5" />}
            loading={reply.isPending}
            onClick={() => reply.mutate()}
          >
            {t('documents.actions.reply')}
          </Button>
        ) : null}
        {document.can.dispatch ? (
          <Button
            variant={document.status === 'registered' ? 'primary' : 'secondary'}
            size="sm"
            icon={<Send className="size-3.5" />}
            onClick={() => setDialog('dispatch')}
          >
            {t('documents.actions.dispatch')}
          </Button>
        ) : null}
        {document.can.file ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Briefcase className="size-3.5" />}
            onClick={() => setDialog('file')}
          >
            {t('documents.actions.file')}
          </Button>
        ) : null}
      </div>
      {dialog === 'dispatch' ? (
        <DispatchDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
      {dialog === 'file' ? (
        <FileDialog document={document} onClose={() => setDialog(null)} onDone={done} />
      ) : null}
    </section>
  )
}

/**
 * Отметка об отправке: адресат — корреспондент (по умолчанию корреспондент
 * документа) или свободный текст, способ и дата; первая отправка исполняет
 * исходящий.
 */
function DispatchDialog({
  document,
  onClose,
  onDone,
}: {
  document: DocumentRecord
  onClose: () => void
  onDone: (record: DocumentRecord) => void
}) {
  const t = useT()
  const toast = useToast()
  const formId = useId()
  const { data: me } = useQuery(meQuery())
  const [correspondent, setCorrespondent] = useState<CorrespondentRef | null>(
    document.correspondent,
  )
  const [addressee, setAddressee] = useState('')
  const [method, setMethod] = useState<DeliveryMethod>('post')
  const [sentOn, setSentOn] = useState(localToday())
  const [tracking, setTracking] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const dispatch = useMutation({
    mutationFn: () =>
      http.post<DocumentRecord>(`/documents/${document.id}/dispatches`, {
        correspondentId: correspondent?.id ?? null,
        addressee: addressee.trim() || null,
        method,
        sentOn,
        tracking: tracking.trim() || null,
      }),
    onSuccess: (record) => {
      toast.show({ title: t('documents.dispatch.done'), tone: 'success' })
      onDone(record)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.dispatch.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={(!correspondent && !addressee.trim()) || !sentOn}
              loading={dispatch.isPending}
              onClick={() => dispatch.mutate()}
            >
              {t('documents.actions.dispatch')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {document.status === 'registered' ? (
            <p className="text-sm text-fg-secondary">{t('documents.dispatch.hint')}</p>
          ) : null}
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.dispatch.correspondent')}>
            <CorrespondentPicker
              value={correspondent}
              onChange={setCorrespondent}
              label={t('documents.dispatch.correspondent')}
              canCreate={me?.capabilities.includes('documents.register') ?? false}
            />
          </Field>
          <Field
            label={t('documents.dispatch.addressee')}
            htmlFor={`${formId}-addressee`}
            hint={t('documents.dispatch.addresseeHint')}
          >
            <Input
              id={`${formId}-addressee`}
              value={addressee}
              maxLength={500}
              onChange={(event) => setAddressee(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('documents.fields.deliveryMethod')}>
              <Select value={method} onValueChange={(next) => setMethod(next as DeliveryMethod)}>
                <SelectTrigger aria-label={t('documents.fields.deliveryMethod')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELIVERY_METHODS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`documents.delivery.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('documents.dispatch.sentOn')} htmlFor={`${formId}-date`}>
              <Input
                id={`${formId}-date`}
                type="date"
                value={sentOn}
                max={localToday()}
                onChange={(event) => setSentOn(event.target.value)}
              />
            </Field>
          </div>
          <Field
            label={t('documents.dispatch.tracking')}
            htmlFor={`${formId}-tracking`}
            hint={t('documents.dispatch.trackingHint')}
          >
            <Input
              id={`${formId}-tracking`}
              value={tracking}
              maxLength={200}
              onChange={(event) => setTracking(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Подшивка в дело: открытые дела, в которые пользователь вправе подшивать;
 * подходящие по типу и подразделению документа — первыми, лучшее выбрано.
 */
function FileDialog({
  document,
  onClose,
  onDone,
}: {
  document: DocumentRecord
  onClose: () => void
  onDone: (record: DocumentRecord) => void
}) {
  const t = useT()
  const toast = useToast()
  const { data, isLoading } = useQuery(caseSuggestionsQuery(document.id))
  const items = data?.items ?? []
  const [caseId, setCaseId] = useState<string>('')
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!caseId && data) setCaseId(data.suggestedId ?? items[0]?.id ?? '')
  }, [caseId, data, items])

  const file = useMutation({
    mutationFn: () => http.post<DocumentRecord>(`/documents/${document.id}/file`, { caseId }),
    onSuccess: (record) => {
      toast.show({
        title: t('documents.file.done', { index: record.case?.index ?? '' }),
        tone: 'success',
      })
      onDone(record)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.file.title')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!caseId}
              loading={file.isPending}
              onClick={() => file.mutate()}
            >
              {t('documents.actions.file')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-secondary">{t('documents.file.hint')}</p>
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {!isLoading && items.length === 0 ? (
            <Callout tone="warning">{t('documents.file.noCases')}</Callout>
          ) : (
            <RadioGroup
              value={caseId}
              onValueChange={setCaseId}
              aria-label={t('documents.file.case')}
              className="flex max-h-72 flex-col gap-1.5 overflow-y-auto"
            >
              {items.map((item) => (
                <RadioItem
                  key={item.id}
                  value={item.id}
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-xs tabular">{item.index}</span>
                      <span className="min-w-0 truncate">{item.title}</span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {item.year}
                        {item.unitName ? ` · ${item.unitName}` : ''}
                      </span>
                      {item.id === data?.suggestedId ? (
                        <Badge size="sm" tone="accent">
                          {t('documents.file.suggested')}
                        </Badge>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </RadioGroup>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
