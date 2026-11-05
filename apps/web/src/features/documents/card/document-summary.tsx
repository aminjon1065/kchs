import { Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { documentQuery } from '../queries.js'
import { DocumentProvider } from './document-context.js'
import { DocumentChips, DocumentRequisitesLine } from './document-header.js'
import { LinksBlock } from './links-block.js'
import { RequisitesView } from './requisites-view.js'
import { RouteOverviewCard } from './route-overview-card.js'

/**
 * Документ дела во Входящих (ADR-0230): чипы, реквизиты одной строкой, маршрут шагами,
 * реквизиты строками и связи — только для чтения. Правка, резолюция и решения шага — в
 * карточке документа и в действиях дела; нет доступа или документ не загрузился — блока нет.
 */
export function DocumentSummary({ objectId }: { objectId: string }) {
  const { data: document, isLoading } = useQuery(documentQuery(objectId))
  if (isLoading) return <Skeleton className="h-48 w-full" />
  if (!document) return null
  return (
    <DocumentProvider document={document} tabId={null}>
      <div className="@container flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DocumentChips />
          </div>
          <DocumentRequisitesLine />
        </div>
        <RouteOverviewCard />
        <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <section className="rounded-xl border border-line bg-surface px-4.5 py-1.5 shadow-sm">
            <RequisitesView document={document} />
          </section>
          <LinksBlock documentId={document.id} />
        </div>
      </div>
    </DocumentProvider>
  )
}
