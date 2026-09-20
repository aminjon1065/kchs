import type { PageOutlineItem } from '@kchs/contracts'
import { useT } from '~/app/i18n.js'

/**
 * Оглавление страницы (03-screens.md §18): пункты с якорями на блоки. Список
 * приходит со снимком страницы, поэтому отстаёт от совместной правки не больше
 * чем на перечитывание карточки — для навигации этого достаточно.
 */
export function PageOutline({ items }: { items: PageOutlineItem[] }) {
  const t = useT()
  if (items.length === 0) {
    return <p className="text-xs text-fg-muted">{t('knowledge.outline.empty')}</p>
  }
  return (
    <nav aria-label={t('knowledge.outline.title')}>
      <ol className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={`${item.blockId}-${item.index}`} style={{ paddingLeft: (item.level - 1) * 12 }}>
            <a
              href={`#page-block-${item.blockId}`}
              className="block truncate rounded-sm px-1 py-0.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              {item.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
