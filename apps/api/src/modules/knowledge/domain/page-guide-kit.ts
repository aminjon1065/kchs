import type { PageBlock } from '@kchs/contracts'

/**
 * Разметка страниц краткого руководства (P5-E07, вопрос N88): абзац, списки, блок
 * с подписью и страница. Общая для всех языков руководства — `page-guide*.ts`.
 */

export type Node = Record<string, unknown>

export const p = (...parts: string[]): Node => ({
  type: 'paragraph',
  content: parts.map((text) => ({ type: 'text', text })),
})

export const ul = (...items: string[]): Node => ({
  type: 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
})

export const ol = (...items: string[]): Node => ({
  type: 'orderedList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
})

/** Текстовый блок с подписью: подпись становится пунктом оглавления страницы. */
export const block = (title: string, ...content: Node[]): Omit<PageBlock, 'id'> =>
  ({ kind: 'text', title, body: { type: 'doc', content } }) as Omit<PageBlock, 'id'>

/** Идентификаторы блоков по порядку: одинаковый вход даёт одинаковый документ. */
export const page = (title: string, ...blocks: Array<Omit<PageBlock, 'id'>>): GuidePage => ({
  title,
  blocks: blocks.map((item, index) => ({ ...item, id: `g-${index + 1}` }) as PageBlock),
})

export interface GuidePage {
  title: string
  blocks: PageBlock[]
}
