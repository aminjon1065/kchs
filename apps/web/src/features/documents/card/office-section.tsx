import { formatDate, formatDateTime } from '@kchs/fields'
import { Callout, KeyValueList, ObjectChip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { dispatchesQuery } from '../queries.js'
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
  const filed = document.case
  // Дело по номенклатуре из номера — пока документ не подшит (ADR-0134)
  const planned = filed ? null : document.registrationCase
  if (!filed && !planned && dispatches.length === 0 && !document.filesDestroyedAt) return null
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
