import type { NotebookCellKind } from '@kchs/contracts'
import { cn, ObjectIcon } from '@kchs/ui'
import { useMemo } from 'react'
import * as Y from 'yjs'
import { useT } from '~/app/i18n.js'
import { useNotebook } from './notebook-context.js'
import { cellIds, cellsOf, useYChanges } from './notebook-doc.js'

interface OutlineItem {
  key: string
  cellId: string
  text: string
  /** 0 — ячейка, 1–3 — заголовок текста. */
  level: number
  kind: NotebookCellKind
}

/** Текст узла Yjs без разметки: заголовок — строкой. */
function plainText(node: Y.XmlElement): string {
  return node
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText
        ? (child.toDelta() as Array<{ insert?: unknown }>)
            .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
            .join('')
        : child instanceof Y.XmlElement
          ? plainText(child)
          : '',
    )
    .join('')
}

/**
 * Оглавление (03-screens.md §9): заголовки текстовых ячеек и подписи остальных;
 * щелчок — к ячейке. Обновляется вместе с документом.
 */
export function NotebookOutline({ onJump }: { onJump: (cellId: string) => void }) {
  const t = useT()
  const { doc } = useNotebook()
  const cells = cellsOf(doc)
  const version = useYChanges(cells as unknown as Y.AbstractType<unknown>, true)
  const orderVersion = useYChanges(doc.getArray('order') as unknown as Y.AbstractType<unknown>)

  // biome-ignore lint/correctness/useExhaustiveDependencies: версии документа — сигнал пересчёта
  const items = useMemo<OutlineItem[]>(() => {
    const out: OutlineItem[] = []
    for (const id of cellIds(doc)) {
      const cell = cells.get(id)
      if (!cell) continue
      const kind = cell.get('kind') as NotebookCellKind
      const title = cell.get('title')
      if (kind === 'text') {
        const body = cell.get('body')
        if (!(body instanceof Y.XmlFragment)) continue
        for (const [index, node] of body.toArray().entries()) {
          if (!(node instanceof Y.XmlElement) || node.nodeName !== 'heading') continue
          const text = plainText(node).trim()
          if (!text) continue
          const level = Number(node.getAttribute('level')) || 1
          out.push({ key: `${id}:${index}`, cellId: id, text, level, kind })
        }
        continue
      }
      out.push({
        key: id,
        cellId: id,
        text: typeof title === 'string' && title ? title : t(`data.notebook.kinds.${kind}`),
        level: 0,
        kind,
      })
    }
    return out
  }, [doc, cells, version, orderVersion, t])

  return (
    <nav aria-label={t('data.notebook.outline')} className="flex flex-col gap-0.5 p-3">
      <h2 className="mb-1 text-2xs font-medium tracking-wide text-fg-muted uppercase">
        {t('data.notebook.outline')}
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('data.notebook.outlineEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onJump(item.cellId)}
                className={cn(
                  'flex w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs',
                  'text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg',
                  item.level === 1 && 'font-semibold text-fg',
                  item.level === 2 && 'pl-4',
                  item.level === 3 && 'pl-6',
                )}
              >
                {item.level === 0 ? (
                  <ObjectIcon
                    type={iconOf(item.kind)}
                    className="size-3.5 shrink-0 text-fg-muted"
                  />
                ) : null}
                <span className="truncate">{item.text}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

/** Значок вида ячейки — значки типов объектов дизайн-системы. */
export function iconOf(kind: NotebookCellKind): string {
  switch (kind) {
    case 'query':
      return 'query'
    case 'chart':
      return 'chart'
    case 'metric':
      return 'metric'
    case 'ai':
      return 'assistant'
    case 'map':
      return 'map'
    default:
      return 'page'
  }
}
