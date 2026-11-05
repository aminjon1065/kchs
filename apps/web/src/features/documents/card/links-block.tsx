import type { LinkView, ObjectSummary } from '@kchs/contracts'
import { Button, ObjectChip } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { objectLinksQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'

/** Сколько связей показывать в карточке — остальные на вкладке «Связи». */
const SHOWN = 6

/** Связи объекта без вложений — для счётчика вкладки и блока карточки. */
export function useDocumentLinks(documentId: string): LinkView[] {
  const { data } = useQuery(objectLinksQuery(documentId))
  return (data?.links ?? []).filter((link) => link.kind !== 'attachment')
}

/**
 * Блок «Связи» карточки (ADR-0230): происшествие, сообщение, предупреждение, файл —
 * чипами объектов; щелчок открывает объект вкладкой. Пусто — блока нет.
 */
export function LinksBlock({ documentId, onAll }: { documentId: string; onAll?: () => void }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const links = useDocumentLinks(documentId)
  if (links.length === 0) return null
  const open = (object: ObjectSummary) =>
    openTab({
      kind: 'object',
      objectId: object.id,
      objectType: object.type,
      title: object.subtitle ? `${object.subtitle} · ${object.title}` : object.title,
      mode: 'permanent',
    })
  return (
    <section
      aria-label={t('documents.card.tabs.links')}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface px-4 py-3.5 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-2xs uppercase tracking-wider text-fg-muted">
          {t('documents.card.tabs.links')}
        </h2>
        {onAll && links.length > SHOWN ? (
          <Button variant="ghost" size="sm" onClick={onAll}>
            {t('documents.card.allLinks', { count: links.length })}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {links.slice(0, SHOWN).map((link) => (
          <ObjectChip
            key={`${link.kind}:${link.object.id}`}
            object={link.object}
            onOpen={() => open(link.object)}
          />
        ))}
      </div>
    </section>
  )
}
