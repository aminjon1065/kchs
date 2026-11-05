import { formatDate, formatDateTime } from '@kchs/fields'
import { Button, Callout, KeyValueList, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { meQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { documentKeys } from '../queries.js'
import { errorText, fieldErrors } from '../status.js'
import { useDocument } from './document-context.js'
import { GovEdmsSection } from './gov-edms-section.js'
import { LinksBlock } from './links-block.js'
import { DocumentOfficeSection } from './office-section.js'
import { documentsCardApi } from './queries.js'
import { type CardValue, cardPayload, cardValueOf, RequisitesForm } from './requisites-form.js'
import { RequisitesView } from './requisites-view.js'
import { RouteOverviewCard } from './route-overview-card.js'

/**
 * Вкладка «Карточка» (03-screens.md §12, ADR-0230): сверху маршрут шагами, слева
 * реквизиты — форма у того, кто правит, строками «подпись — значение» у остальных;
 * справа регистрация, связи и разделы делопроизводства. Аннулирование — справочно.
 */
export function CardTab() {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const { document, refresh, openSection } = useDocument()
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
    mutationFn: () => documentsCardApi.patch(document.id, cardPayload(value)),
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
    <div className="@container mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-6 py-5">
      {document.status === 'cancelled' ? (
        <Callout tone="warning" title={t('documents.cancel.cancelled')}>
          {document.cancelReason}
        </Callout>
      ) : null}
      <RouteOverviewCard onDetails={() => openSection('route')} />
      <div className="grid items-start gap-4 @2xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section
          aria-label={t('documents.card.requisites')}
          className={
            document.can.edit
              ? 'rounded-xl border border-line bg-surface p-4 shadow-sm'
              : 'rounded-xl border border-line bg-surface px-4.5 py-1.5 shadow-sm'
          }
        >
          {document.can.edit ? (
            <>
              <RequisitesForm
                type={document.type}
                value={value}
                onChange={setValue}
                errors={errors}
                canCreateCorrespondent={canCreateCorrespondent}
              />
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
            </>
          ) : (
            <RequisitesView document={document} />
          )}
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          {registration ? (
            <section
              aria-label={t('documents.card.registration')}
              className="rounded-xl border border-line bg-surface px-4 py-3.5 shadow-sm"
            >
              <h2 className="mb-2.5 font-mono text-2xs uppercase tracking-wider text-fg-muted">
                {t('documents.card.registration')}
              </h2>
              <KeyValueList
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
          <LinksBlock documentId={document.id} onAll={() => openSection('links')} />
          <DocumentOfficeSection />
          <GovEdmsSection />
        </div>
      </div>
    </div>
  )
}
