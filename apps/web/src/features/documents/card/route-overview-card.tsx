import { Button, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Suspense } from 'react'
import {
  LazyRouteOverview,
  objectProcessesQuery,
  processQuery,
} from '~/features/processes/index.js'
import { useT } from '~/shared/i18n.js'
import { useDocument } from './document-context.js'

/**
 * Маршрут на вкладке «Карточка» (ADR-0230): последний маршрут документа шагами — кто,
 * когда, норма и остаток, «ваш шаг» выделен. Подробности (решения, версии, подписи,
 * отзыв) — на вкладке «Маршрут».
 */
export function RouteOverviewCard({ onDetails }: { onDetails?: () => void }) {
  const t = useT()
  const { document } = useDocument()
  const instances = useQuery(objectProcessesQuery(document.id))
  const current = document.route?.instanceId ?? instances.data?.[0]?.id ?? null
  const view = useQuery({
    ...processQuery(document.id, current ?? ''),
    enabled: Boolean(current),
  })
  if (!current) return null
  return (
    <section
      aria-label={t('documents.card.route')}
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-4.5 py-4 shadow-sm"
    >
      {view.data ? (
        <Suspense fallback={<Skeleton className="h-20 w-full" />}>
          <LazyRouteOverview view={view.data} />
        </Suspense>
      ) : (
        <Skeleton className="h-20 w-full" />
      )}
      {onDetails ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onDetails}>
            {t('documents.card.routeDetails')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
