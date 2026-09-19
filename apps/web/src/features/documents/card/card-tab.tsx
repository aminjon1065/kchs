import type { DocumentRecord } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { Button, Callout, KeyValueList, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { documentKeys } from '../queries.js'
import { errorText, fieldErrors } from '../status.js'
import { useDocument } from './document-context.js'
import { DocumentOfficeSection } from './office-section.js'
import { type CardValue, cardPayload, cardValueOf, RequisitesForm } from './requisites-form.js'

/**
 * Вкладка «Карточка» (03-screens.md §12): реквизиты и поля типа — правятся
 * при праве правки, пока документ не закрыт; регистрационные данные и
 * аннулирование — справочно.
 */
export function CardTab() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { document, refresh } = useDocument()
  const { data: me } = useQuery(meQuery())
  const [value, setValue] = useState<CardValue>(() => cardValueOf(document))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const baseline = JSON.stringify(cardValueOf(document))
  const dirty = JSON.stringify(value) !== baseline

  // Документ перечитан (realtime, соседняя вкладка) — несохранённых правок нет: берём его
  // biome-ignore lint/correctness/useExhaustiveDependencies: сравнение по снимку карточки
  useEffect(() => {
    if (!dirty) setValue(cardValueOf(document))
  }, [baseline])

  const save = useMutation({
    mutationFn: () => http.patch<DocumentRecord>(`/documents/${document.id}`, cardPayload(value)),
    onSuccess: (record) => {
      client.setQueryData(documentKeys.document(document.id), record)
      setValue(cardValueOf(record))
      setErrors({})
      toast.show({ title: t('documents.card.saved'), tone: 'success' })
      refresh()
    },
    onError: (error) => {
      setErrors(fieldErrors(error))
      toast.error(errorText(error, t('errors.unknown')))
    },
  })

  const registration = document.registration
  const canCreateCorrespondent = me?.capabilities.includes('documents.register') ?? false

  return (
    <div className="mx-auto flex max-w-[980px] flex-col gap-5 p-6">
      {document.status === 'cancelled' ? (
        <Callout tone="warning" title={t('documents.cancel.cancelled')}>
          {document.cancelReason}
        </Callout>
      ) : null}
      {registration ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('documents.card.registration')}</h2>
          <KeyValueList
            columns={2}
            items={[
              {
                key: 'number',
                label: t('documents.fields.regNumber'),
                value: <span className="font-mono tabular">{registration.number}</span>,
              },
              {
                key: 'date',
                label: t('documents.fields.regDate'),
                value: document.regDate ? formatDate(document.regDate, { locale }) : '—',
              },
              {
                key: 'journal',
                label: t('documents.fields.journal'),
                value: registration.journalName,
              },
              {
                key: 'by',
                label: t('documents.card.registeredBy'),
                value: `${registration.registeredBy?.displayName ?? '—'} · ${formatDateTime(registration.registeredAt, { locale })}`,
              },
            ]}
          />
          {registration.reserved ? (
            <p className="mt-2 text-xs text-fg-muted">{t('documents.card.fromReservation')}</p>
          ) : null}
        </section>
      ) : null}
      <DocumentOfficeSection />

      <section className="rounded-lg border border-line bg-surface p-4">
        <RequisitesForm
          type={document.type}
          value={value}
          onChange={setValue}
          errors={errors}
          readOnly={!document.can.edit}
          canCreateCorrespondent={canCreateCorrespondent}
        />
        {document.can.edit ? (
          <div className="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3">
            {dirty ? (
              <Button variant="ghost" onClick={() => setValue(cardValueOf(document))}>
                {t('common.actions.reset')}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('common.actions.save')}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
