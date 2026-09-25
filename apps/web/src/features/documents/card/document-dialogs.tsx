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
import {
  caseSuggestionsQuery,
  journalReservationsQuery,
  journalsQuery,
  numberPreviewQuery,
} from '../queries.js'
import { errorText } from '../status.js'

const NO_RESERVATION = '__none'
/** Дело не выбрано — номер без индекса дела. */
const NO_CASE = 'none'

/**
 * Регистрация (08-documents.md §5): журнал типа по умолчанию или выбранный,
 * для бумажного документа — номер из резерва журнала. Если в формате номера есть индекс
 * дела, дело по номенклатуре подбирается по типу и подразделению и видно в номере сразу
 * (ADR-0134): чаще всего делопроизводителю остаётся только нажать «Зарегистрировать».
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
  const { data: suggestions } = useQuery(caseSuggestionsQuery(document.id, 'registration'))
  // Пусто — дело ещё не выбрано: берётся подобранное по типу и подразделению
  const [caseChoice, setCaseChoice] = useState('')
  const caseId = caseChoice || (suggestions ? (suggestions.suggestedId ?? NO_CASE) : '')
  const { data: preview } = useQuery({
    ...numberPreviewQuery(document.id, journalId, caseId || 'auto'),
    enabled: Boolean(journalId) && Boolean(suggestions),
  })
  const usesCase = preview?.usesCase ?? false
  const reserved = reservationId !== NO_RESERVATION

  useEffect(() => {
    if (!journalId && allowed[0]) setJournalId(allowed[0].id)
  }, [journalId, allowed])

  const register = useMutation({
    mutationFn: () =>
      http.post<DocumentRecord>(`/documents/${document.id}/register`, {
        journalId,
        ...(reserved ? { reservationId } : {}),
        ...(usesCase && caseId ? { caseId: caseId === NO_CASE ? null : caseId } : {}),
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
            <Select
              value={journalId}
              onValueChange={(next) => {
                // Резерв — номер конкретного журнала: при смене журнала — новый номер
                setJournalId(next)
                setReservationId(NO_RESERVATION)
              }}
            >
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
          {usesCase && !reserved ? (
            <Field label={t('documents.register.case')} hint={t('documents.register.caseHint')}>
              <Select value={caseId} onValueChange={setCaseChoice}>
                <SelectTrigger aria-label={t('documents.register.case')}>
                  <SelectValue placeholder={t('documents.placeholders.choose')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CASE}>{t('documents.register.noCase')}</SelectItem>
                  {(suggestions?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.index} · {item.title}
                      {item.unitName ? ` · ${item.unitName}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {usesCase && !reserved && suggestions?.items.length === 0 ? (
            <p className="text-xs text-fg-muted">{t('documents.register.noCases')}</p>
          ) : null}
          {current && !reserved ? (
            <p className="text-xs text-fg-muted">
              {preview
                ? t('documents.register.numberPreview', { number: preview.number })
                : t('documents.register.nextNumber', { number: current.nextNumber })}
            </p>
          ) : null}
          {usesCase && reserved ? (
            <p className="text-xs text-fg-muted">{t('documents.register.reservationCase')}</p>
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
          <p className="text-sm text-fg-secondary">
            {document.regNumber ? t('documents.cancel.hint') : t('documents.cancel.hintDraft')}
          </p>
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
