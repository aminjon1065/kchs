/**
 * Богатый текст — Tiptap JSON (ADR-0018): `{type: 'doc', content: [...]}`.
 * Белый список узлов и меток общий для редактора дизайн-системы и сервера:
 * сервер переводит совместные документы в JSON и обратно только в его
 * пределах, остальное отбрасывает (чужие узлы, `javascript:` в ссылках).
 */

/** Блочные и строчные узлы, которые понимает RichTextEditor (StarterKit без изображений). */
export const RICH_TEXT_NODES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
] as const

export const RICH_TEXT_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const

/** Атрибуты узлов и меток, которые переживают перевод; остальные отбрасываются. */
export const RICH_TEXT_ATTRS: Readonly<Record<string, readonly string[]>> = {
  heading: ['level'],
  orderedList: ['start'],
  codeBlock: ['language'],
  link: ['href'],
}

/** Схемы ссылок, допустимые в тексте. */
const SAFE_HREF = /^(https?:|mailto:|tel:|\/|#)/i

/** Ссылка безопасна для показа: http(s), почта, телефон или путь приложения. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const value = href.trim()
  return value && SAFE_HREF.test(value) ? value.slice(0, 2000) : null
}

/** Плоский текст документа Tiptap: абзацы и заголовки — строками (поиск, оглавление). */
export function richBodyText(
  body: { content?: ReadonlyArray<unknown> } | null | undefined,
): string {
  const lines: string[] = []
  for (const node of body?.content ?? []) collectLines(node, lines)
  return lines.join('\n')
}

const INLINE = new Set(['text', 'hardBreak', 'mention'])

interface JsonNode {
  type?: unknown
  text?: unknown
  content?: unknown
  attrs?: unknown
}

function childrenOf(node: JsonNode): JsonNode[] {
  return Array.isArray(node.content)
    ? node.content.filter((child): child is JsonNode => typeof child === 'object' && child !== null)
    : []
}

/** Блок из строчных узлов — одна строка; блок из блоков (список, цитата) — обход вглубь. */
function collectLines(value: unknown, lines: string[]): void {
  if (typeof value !== 'object' || value === null) return
  const children = childrenOf(value as JsonNode)
  if (children.some((child) => !INLINE.has(String(child.type)))) {
    for (const child of children) collectLines(child, lines)
    return
  }
  const text = children.map(inlineText).join('')
  if (text.trim()) lines.push(text)
}

function inlineText(node: JsonNode): string {
  if (typeof node.text === 'string') return node.text
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention') {
    const label = (node.attrs as { label?: unknown } | undefined)?.label
    return typeof label === 'string' ? `@${label}` : ''
  }
  return ''
}
