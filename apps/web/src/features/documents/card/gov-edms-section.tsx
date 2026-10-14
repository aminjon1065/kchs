import { formatDate } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  KeyValueList,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Landmark, Send } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import {
  govEdmsKeys,
  govEdmsOutgoingQuery,
  govEdmsPackage,
  govEdmsTransferred,
} from '../gov-edms/queries.js'
import { saveLink } from '../print/save-link.js'
import { documentKeys } from '../queries.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'

/** Отметка о передаче возможна у зарегистрированного или исполненного исходящего. */
const TRANSFERABLE = new Set(['registered', 'executed'])

/**
 * Исходящий адресату, который обменивается через госЭДО (ADR-0219): пакет для ручной
 * загрузки в госсистему и отметка «передано» с номером в ней. Пока передачи нет — во
 * Входящих регистратора дело «Передать в госЭДО».
 */
export function GovEdmsSection() {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const { document } = useDocument()
  const outgoing = document.type.direction === 'outgoing'
  const { data: state } = useQuery({ ...govEdmsOutgoingQuery(document.id), enabled: outgoing })
  const [marking, setMarking] = useState(false)

  const pack = useMutation({
    mutationFn: () => govEdmsPackage(document.id),
    onSuccess: (result) => {
      saveLink(result)
      toast.show({ title: t('documents.govEdms.outgoing.packageReady', { files: result.files }) })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })

  if (!outgoing || !state || (!state.exchange && state.transfers.length === 0)) return null
  const canAct = document.can.dispatch && TRANSFERABLE.has(document.status)

  return (
    <section
      className="rounded-lg border border-line bg-surface p-4"
      aria-labelledby="gov-edms-title"
    >
      <h2
        id="gov-edms-title"
        className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg"
      >
        <Landmark className="size-4 text-fg-muted" aria-hidden />
        {t('documents.govEdms.outgoing.title')}
      </h2>
      {state.pending ? (
        <Callout tone="info" className="mb-3" title={t('documents.govEdms.outgoing.pending')}>
          {t('documents.govEdms.outgoing.hint')}
        </Callout>
      ) : null}
      {state.transfers.length > 0 ? (
        <KeyValueList
          className="mb-3"
          items={state.transfers.map((transfer) => ({
            key: transfer.id,
            label: t('documents.govEdms.outgoing.transferredLabel'),
            value: t('documents.govEdms.outgoing.transferred', {
              date: formatDate(transfer.sentOn, { locale }),
              number: transfer.tracking ?? '—',
            }),
          }))}
        />
      ) : null}
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Download className="size-3.5" />}
            loading={pack.isPending}
            onClick={() => pack.mutate()}
          >
            {t('documents.govEdms.outgoing.package')}
          </Button>
          <Button
            variant={state.pending ? 'primary' : 'secondary'}
            size="sm"
            icon={<Send className="size-3.5" />}
            onClick={() => setMarking(true)}
          >
            {t('documents.govEdms.outgoing.mark')}
          </Button>
        </div>
      ) : null}
      {marking ? (
        <TransferDialog
          documentId={document.id}
          onClose={() => setMarking(false)}
          onDone={() => {
            setMarking(false)
            void client.invalidateQueries({ queryKey: govEdmsKeys.outgoing(document.id) })
            void client.invalidateQueries({ queryKey: documentKeys.document(document.id) })
            void client.invalidateQueries({ queryKey: documentKeys.dispatches(document.id) })
          }}
        />
      ) : null}
    </section>
  )
}

function TransferDialog({
  documentId,
  onClose,
  onDone,
}: {
  documentId: string
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const toast = useToast()
  const [sentOn, setSentOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [externalNumber, setExternalNumber] = useState('')
  const [note, setNote] = useState('')
  const mark = useMutation({
    mutationFn: () =>
      govEdmsTransferred(documentId, {
        sentOn,
        externalNumber: externalNumber.trim(),
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.show({ title: t('documents.govEdms.outgoing.marked'), tone: 'success' })
      onDone()
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('documents.govEdms.outgoing.markTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!externalNumber.trim() || !sentOn}
              loading={mark.isPending}
              onClick={() => mark.mutate()}
            >
              {t('documents.govEdms.outgoing.mark')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('documents.govEdms.outgoing.sentOn')}>
            <Input type="date" value={sentOn} onChange={(event) => setSentOn(event.target.value)} />
          </Field>
          <Field label={t('documents.govEdms.outgoing.externalNumber')}>
            <Input
              value={externalNumber}
              maxLength={200}
              onChange={(event) => setExternalNumber(event.target.value)}
            />
          </Field>
          <Field label={t('documents.govEdms.outgoing.note')}>
            <Textarea
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
