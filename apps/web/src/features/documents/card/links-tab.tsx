import type { LinkView } from '@kchs/contracts'
import { EmptyState, ObjectChip, Skeleton } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { objectLinksQuery } from '~/shared/api/queries.js'
import { useDocument } from './document-context.js'

/**
 * Слот вкладки «Связи» (08-documents.md §11; вторая волна P3-E02 S10 добавит
 * виды reply_to, in_execution_of, cancels, amends и цепочку переписки). Сейчас —
 * связи реестра ядра, кроме вложений (они — во вкладке «Файлы и версии»);
 * недоступные объекты — чипом «нет доступа» без названия.
 */
export function LinksTab() {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { document } = useDocument()
  const { data, isLoading } = useQuery(objectLinksQuery(document.id))
  const links = (data?.links ?? []).filter((link: LinkView) => link.kind !== 'attachment')

  if (isLoading) return <Skeleton className="m-6 h-24" />
  if (links.length === 0) {
    return (
      <EmptyState
        icon={<Link2 />}
        title={t('objects.links.empty')}
        description={t('documents.links.hint')}
      />
    )
  }
  return (
    <ul className="mx-auto flex max-w-[820px] flex-col gap-2 p-6">
      {links.map((link) => (
        <li key={link.id} className="flex items-center gap-3">
          <span className="w-40 shrink-0 text-xs text-fg-muted">
            {t(`objects.links.kind.${link.kind}`)}
          </span>
          <ObjectChip
            object={{
              id: link.object.id,
              type: link.object.type,
              title: link.object.title,
              subtitle: link.object.subtitle,
              accessible: link.object.accessible,
            }}
            onOpen={
              link.object.accessible
                ? () =>
                    openTab({
                      kind: 'object',
                      objectId: link.object.id,
                      objectType: link.object.type,
                      title: link.object.title,
                      mode: 'permanent',
                    })
                : undefined
            }
          />
        </li>
      ))}
    </ul>
  )
}
