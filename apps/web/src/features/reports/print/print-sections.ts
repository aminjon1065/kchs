import type { ReportBlock, ReportPrintBlock } from '@kchs/contracts'

/**
 * Разделы отчёта для оглавления и нумерации (ADR-0164): подписи блоков и заголовки текста.
 * Подпись блока и заголовок первого-второго уровня — раздел («1.»), заголовок третьего и
 * глубже — подраздел («1.1.»). Нумерация пишется прямо в подписи и заголовки блоков: так
 * она одинакова на странице, в PDF и в модели DOCX.
 */
export interface TocEntry {
  level: 1 | 2
  number: string
  text: string
}

type RichNode = { type?: string; attrs?: { level?: number }; content?: RichNode[]; text?: string }

function nodeText(node: RichNode): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(nodeText).join('')
}

class Counter {
  private major = 0
  private minor = 0

  next(level: 1 | 2): string {
    if (level === 1 || this.major === 0) {
      this.major += 1
      this.minor = 0
      return `${this.major}.`
    }
    this.minor += 1
    return `${this.major}.${this.minor}.`
  }
}

/** Блоки с нумерацией в подписях и заголовках и записи оглавления по ним. */
export function reportSections(
  blocks: readonly ReportBlock[],
  numbering: boolean,
): { blocks: ReportBlock[]; toc: TocEntry[] } {
  const counter = new Counter()
  const toc: TocEntry[] = []
  const numbered = blocks.map((block): ReportBlock => {
    if (block.kind === 'page_break') return block
    if (block.kind === 'text') {
      const content = (block.body.content as RichNode[]).map((node) => {
        if (node.type !== 'heading') return node
        const text = nodeText(node).trim()
        if (!text) return node
        const level: 1 | 2 = (node.attrs?.level ?? 1) >= 3 ? 2 : 1
        const number = counter.next(level)
        toc.push({ level, number, text })
        if (!numbering) return node
        return { ...node, content: [{ type: 'text', text: `${number} ` }, ...(node.content ?? [])] }
      })
      return { ...block, body: { ...block.body, content } } as ReportBlock
    }
    const title = block.title?.trim()
    if (!title) return block
    const number = counter.next(1)
    toc.push({ level: 1, number, text: title })
    return numbering ? { ...block, title: `${number} ${title}` } : block
  })
  return { blocks: numbered, toc }
}

/** Оглавление в модели DOCX: заголовок и строки абзацами, затем разрыв страницы. */
export function tocModel(
  entries: readonly TocEntry[],
  heading: string,
  numbering: boolean,
): ReportPrintBlock[] {
  if (entries.length === 0) return []
  const line = (entry: TocEntry) => ({
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text: `${entry.level === 2 ? '    ' : ''}${numbering ? `${entry.number} ` : ''}${entry.text}`,
      },
    ],
  })
  return [
    {
      id: 'toc',
      kind: 'text',
      body: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
          ...entries.map(line),
        ],
      },
    },
    { id: 'toc-break', kind: 'page_break' },
  ]
}
