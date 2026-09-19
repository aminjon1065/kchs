import { formatDateTime } from '@kchs/fields'
import { EmptyState, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { objectActivityQuery } from '~/shared/api/queries.js'
import { useDocument } from './document-context.js'

/**
 * Вкладка «История» (03-screens.md §12): лента документа из событий —
 * создание, правки карточки, версии, регистрация, гриф, аннулирование.
 */
export function HistoryTab() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { document } = useDocument()
  const { data, isLoading } = useQuery(objectActivityQuery(document.id))

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>
    )
  }
  if (!data?.items.length) {
    return <EmptyState icon={<History />} title={t('objects.activity.empty')} />
  }
  return (
    <ol className="mx-auto flex max-w-[820px] flex-col p-6">
      {data.items.map((item, index) => (
        <li key={item.id} className="relative flex gap-3 pb-4">
          {index < data.items.length - 1 ? (
            <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-line" />
          ) : null}
          <span className="relative z-10 mt-1 size-3.5 shrink-0 rounded-full border-2 border-surface bg-line-strong" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-fg">
              {t(item.summary.key, item.summary.params as Record<string, string>)}
            </p>
            <time className="text-xs text-fg-muted" dateTime={item.occurredAt}>
              {formatDateTime(item.occurredAt, { locale })}
            </time>
          </div>
        </li>
      ))}
    </ol>
  )
}
