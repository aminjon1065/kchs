import type { DocumentRecord } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { journalReservationsQuery, journalsQuery } from '../queries.js'
import { errorText } from '../status.js'

const NO_RESERVATION = '__none'

/**
 * Регистрация (08-documents.md §5): журнал типа по умолчанию или выбранный,
 * для бумажного документа — номер из резерва журнала.
 */
export function RegisterDialog({
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
  const { data: journals = [] } = useQuery(journalsQuery())
  const allowed = journals.filter(
    (journal) =>
      journal.canRegister &&
      (journal.typeIds.length === 0 || journal.typeIds.includes(document.type.id)),
  )
  const [journalId, setJournalId] = useState<string>(document.type.journalId ?? '')
  const [reservationId, setReservationId] = useState<string>(NO_RESERVATION)
  const [failure, setFailure] = useState<string | null>(null)
  const { data: reservations = [] } = useQuery({
    ...journalReservationsQuery(journalId),
    enabled: Boolean(journalId),
  })
  const open = reservations.filter((reservation) => reservation.state === 'open')
  const current = allowed.find((journal) => journal.id === journalId)

  useEffect(() => {
    if (!journalId && allowed[0]) setJournalId(allowed[0].id)
  }, [journalId, allowed])

  const register = useMutation({
    mutationFn: () =>
      http.post<DocumentRecord>(`/documents/${document.id}/register`, {
        journalId,
        ...(reservationId !== NO_RESERVATION ? { reservationId } : {}),
      }),
    onSuccess: (record) => {
      toast.show({
        title: t('documents.register.done', { number: record.regNumber ?? '' }),
        tone: 'success',
      })
      onDone(record)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.register.dialogTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!journalId}
              loading={register.isPending}
              onClick={() => register.mutate()}
            >
              {t('documents.actions.register')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.fields.journal')}>
            <Select value={journalId} onValueChange={setJournalId}>
              <SelectTrigger aria-label={t('documents.fields.journal')}>
                <SelectValue placeholder={t('documents.placeholders.choose')} />
              </SelectTrigger>
              <SelectContent>
                {allowed.map((journal) => (
                  <SelectItem key={journal.id} value={journal.id}>
                    {journal.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {current ? (
            <p className="text-xs text-fg-muted">
              {t('documents.register.nextNumber', { number: current.nextNumber })}
            </p>
          ) : null}
          {open.length > 0 ? (
            <Field
              label={t('documents.register.reservation')}
              hint={t('documents.register.reservationHint')}
            >
              <Select value={reservationId} onValueChange={setReservationId}>
                <SelectTrigger aria-label={t('documents.register.reservation')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RESERVATION}>
                    {t('documents.register.noReservation')}
                  </SelectItem>
                  {open.map((reservation) => (
                    <SelectItem key={reservation.id} value={reservation.id}>
                      {reservation.number} · {reservation.note}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Аннулирование — только с обоснованием (08-documents.md §3); попадает в аудит. */
export function CancelDialog({
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
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const cancel = useMutation({
    mutationFn: () =>
      http.post<DocumentRecord>(`/documents/${document.id}/cancel`, { reason: reason.trim() }),
    onSuccess: (record) => {
      toast.show({ title: t('documents.cancel.done'), tone: 'info' })
      onDone(record)
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.cancel.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 5}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t('documents.actions.cancel')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-secondary">{t('documents.cancel.hint')}</p>
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.cancel.reason')} htmlFor={reasonId} required>
            <Textarea
              id={reasonId}
              value={reason}
              rows={3}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
