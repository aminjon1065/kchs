import type { DocumentEmail, DocumentEmailStatus } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { Badge, Button, Callout, KeyValueList, ObjectChip, useToast } from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { http } from '~/shared/api/client.js'
import { dispatchesQuery, documentKeys, emailsQuery } from '../queries.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'

/**
 * Дело и отправка на вкладке «Карточка» (ADR-0086): в какое дело подшит
 * документ, отметки об отправке исходящего, уничтожение файлов по акту.
 */
export function DocumentOfficeSection() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { document } = useDocument()
  const { data: dispatches = [] } = useQuery({
    ...dispatchesQuery(document.id),
    enabled: document.dispatchCount > 0,
  })
  const { data: emails = [] } = useQuery({
    ...emailsQuery(document.id),
    enabled: document.type.direction === 'outgoing',
  })
  const filed = document.case
  // Дело по номенклатуре из номера — пока документ не подшит (ADR-0134)
  const planned = filed ? null : document.registrationCase
  if (
    !filed &&
    !planned &&
    dispatches.length === 0 &&
    emails.length === 0 &&
    !document.filesDestroyedAt
  ) {
    return null
  }
  const openCase = (item: { id: string; index: string; title: string }) =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'case',
      title: `${item.index} · ${item.title}`,
      mode: 'permanent',
    })

  return (
    <>
      {document.filesDestroyedAt ? (
        <Callout tone="warning" title={t('documents.office.filesDestroyed')}>
          {t('documents.office.filesDestroyedHint', {
            date: formatDateTime(document.filesDestroyedAt, { locale }),
          })}
        </Callout>
      ) : null}
      {filed ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('documents.office.case')}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <ObjectChip
              object={{
                id: filed.id,
                type: 'case',
                title: filed.title,
                subtitle: `${filed.index} · ${filed.year}`,
              }}
              onOpen={() => openCase(filed)}
            />
            {document.filedAt ? (
              <span className="text-xs text-fg-muted">
                {t('documents.office.filedAt', {
                  date: formatDateTime(document.filedAt, { locale }),
                })}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
      {planned ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">
            {t('documents.office.registrationCase')}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <ObjectChip
              object={{
                id: planned.id,
                type: 'case',
                title: planned.title,
                subtitle: `${planned.index} · ${planned.year}`,
              }}
              onOpen={() => openCase(planned)}
            />
            <span className="text-xs text-fg-muted">
              {t('documents.office.registrationCaseHint')}
            </span>
          </div>
        </section>
      ) : null}
      {emails.length > 0 ? (
        <DocumentEmails documentId={document.id} emails={emails} canRetry={document.can.dispatch} />
      ) : null}
      {dispatches.length > 0 ? (
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-3 text-sm font-semibold text-fg">{t('documents.office.dispatches')}</h2>
          <ul className="flex flex-col gap-3">
            {dispatches.map((dispatch) => (
              <li key={dispatch.id}>
                <KeyValueList
                  columns={2}
                  items={[
                    {
                      key: 'to',
                      label: t('documents.dispatch.addressee'),
                      value: dispatch.correspondent?.name ?? dispatch.addressee ?? '—',
                    },
                    {
                      key: 'on',
                      label: t('documents.dispatch.sentOn'),
                      value: `${formatDate(dispatch.sentOn, { locale })} · ${t(
                        `documents.delivery.${dispatch.method}`,
                      )}`,
                    },
                    ...(dispatch.tracking
                      ? [
                          {
                            key: 'tracking',
                            label: t('documents.dispatch.tracking'),
                            value: dispatch.tracking,
                          },
                        ]
                      : []),
                    {
                      key: 'by',
                      label: t('documents.dispatch.by'),
                      value: dispatch.createdBy?.displayName ?? '—',
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

const EMAIL_TONES: Record<DocumentEmailStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
  bounced: 'warning',
}

/**
 * Письма исходящего (ADR-0149): кому, в каком состоянии, почему не ушло. Не ушедшее или
 * вернувшееся письмо ставится снова кнопкой «Повторить».
 */
function DocumentEmails({
  documentId,
  emails,
  canRetry,
}: {
  documentId: string
  emails: DocumentEmail[]
  canRetry: boolean
}) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const client = useQueryClient()
  const retry = useMutation({
    mutationFn: (emailId: string) =>
      http.post(`/documents/${documentId}/emails/${emailId}/retry`, {}),
    onSuccess: () => {
      toast.show({ title: t('documents.email.retried'), tone: 'success' })
      void client.invalidateQueries({ queryKey: documentKeys.emails(documentId) })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  return (
    <section
      className="rounded-lg border border-line bg-surface p-4"
      aria-label={t('documents.email.list')}
    >
      <h2 className="mb-3 text-sm font-semibold text-fg">{t('documents.email.list')}</h2>
      <ul className="flex flex-col gap-3">
        {emails.map((email) => (
          <li key={email.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-fg">{email.to}</span>
              <Badge size="sm" tone={EMAIL_TONES[email.status]}>
                {t(`documents.email.statuses.${email.status}`)}
              </Badge>
              {canRetry && (email.status === 'failed' || email.status === 'bounced') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={retry.isPending && retry.variables === email.id}
                  onClick={() => retry.mutate(email.id)}
                >
                  {t('documents.email.retry')}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-fg-muted">
              {email.createdBy?.displayName ?? '—'} ·{' '}
              {formatDateTime(email.sentAt ?? email.createdAt, { locale })}
            </p>
            {email.error ? <p className="text-xs text-danger">{email.error}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
