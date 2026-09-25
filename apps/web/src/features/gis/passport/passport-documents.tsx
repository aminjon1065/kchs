import type { DocumentTerritoryItem, Locale } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { DataTable, type DataTableColumn, EmptyState, Skeleton, StatusBadge } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { territoryDocumentsQuery } from '../../documents/queries.js'
import { DOCUMENT_STATUS_TONE } from '../../documents/status.js'
import { TerritoryLink } from '../territory-link.js'

/**
 * Вкладка «Документы» паспорта (ADR-0158): документы с этой территорией и вложенными
 * единицами — по реквизиту «Территория», полю-территории карточки или связи «о
 * территории». Сервер отдаёт только документы, открытые смотрящему.
 */
export function PassportDocuments({ territoryId }: { territoryId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(territoryDocumentsQuery(territoryId))

  const open = (item: DocumentTerritoryItem, permanent: boolean) =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'document',
      title: item.title,
      mode: permanent ? 'permanent' : 'preview',
    })

  const columns: Array<DataTableColumn<DocumentTerritoryItem>> = [
    {
      key: 'regNumber',
      header: t('documents.fields.regNumber'),
      width: 130,
      cell: (item) => item.regNumber ?? '—',
    },
    {
      key: 'date',
      header: t('documents.fields.regDate'),
      width: 110,
      cell: (item) => formatDate(item.regDate ?? item.createdAt.slice(0, 10), { locale }),
    },
    { key: 'title', header: t('documents.fields.subject'), width: 320, cell: (item) => item.title },
    {
      key: 'type',
      header: t('documents.fields.type'),
      width: 200,
      cell: (item) => item.typeName[locale] ?? item.typeName.ru,
    },
    {
      key: 'status',
      header: t('documents.fields.status'),
      width: 150,
      cell: (item) => (
        <StatusBadge
          status={DOCUMENT_STATUS_TONE[item.status]}
          label={t(`documents.statuses.${item.status}`)}
        />
      ),
    },
    {
      key: 'territory',
      header: t('tasks.fields.territory'),
      width: 180,
      cell: (item) => <TerritoryLink id={item.territoryId} />,
    },
    {
      key: 'via',
      header: t('gis.passport.documentVia.title'),
      width: 170,
      cell: (item) => t(`gis.passport.documentVia.${item.via}`),
    },
  ]

  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!data || data.items.length === 0) {
    return (
      <EmptyState
        title={t('gis.passport.documentsTitle')}
        description={t('gis.passport.documentsHint')}
      />
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <DataTable
        rows={data.items}
        getRowId={(item) => item.id}
        columns={columns}
        className="h-72"
        aria-label={t('gis.passport.tabs.documents')}
        onRowOpen={(item) => open(item, true)}
        onRowClick={(item) => open(item, false)}
      />
      {data.total > data.items.length ? (
        <p className="text-xs text-fg-muted">
          {t('gis.passport.documentsMore', { shown: data.items.length, total: data.total })}
        </p>
      ) : null}
    </div>
  )
}
