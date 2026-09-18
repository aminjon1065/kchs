import type { RichBody } from '@kchs/contracts'

export interface Mention {
  id: string
  name: string
}

export interface ComposedMessage {
  text: string
  body: RichBody
  mentions: string[]
  /** Идентификаторы файлов-вложений (загружены заранее как вложения объекта). */
  attachments: string[]
}

/** «@» и начало имени перед курсором — запрос упоминания. */
const TRIGGER = /(?:^|\s)@([\p{L}\p{N}._-]{1,40})$/u

/** Набираемое упоминание перед курсором: текст запроса и позиция «@». */
export function mentionQuery(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const name = TRIGGER.exec(value.slice(0, caret))?.[1]
  return name ? { query: name, start: caret - name.length - 1 } : null
}

/**
 * Документ Tiptap из текста: упоминания — узлы `mention` с идентификатором,
 * остальное — текст. Сервер рассылает уведомления по `mentions`, а узлы нужны
 * для отображения и будущего редактора. Из совпадающих в одной позиции имён
 * берётся самое длинное («Иванов Иван», а не «Иванов»).
 */
export function toDoc(text: string, mentions: Mention[]): RichBody {
  const labels = mentions
    .map((mention) => ({ ...mention, label: `@${mention.name}` }))
    .sort((a, b) => b.label.length - a.label.length)
  const content: Array<Record<string, unknown>> = []
  let rest = text
  while (rest) {
    let found: { index: number; mention: (typeof labels)[number] } | null = null
    for (const mention of labels) {
      const index = rest.indexOf(mention.label)
      if (index >= 0 && (found === null || index < found.index)) found = { index, mention }
    }
    if (!found) {
      content.push({ type: 'text', text: rest })
      break
    }
    if (found.index > 0) content.push({ type: 'text', text: rest.slice(0, found.index) })
    content.push({ type: 'mention', attrs: { id: found.mention.id, label: found.mention.name } })
    rest = rest.slice(found.index + found.mention.label.length)
  }
  return { type: 'doc', content: [{ type: 'paragraph', content }] }
}

/**
 * Сообщение к отправке; упоминание, стёртое из текста, не уведомляет.
 * Пустым может быть текст, если есть вложения.
 */
export function composeMessage(
  draft: string,
  mentions: Mention[],
  attachments: string[] = [],
): ComposedMessage | null {
  const text = draft.trim()
  if (!text && attachments.length === 0) return null
  const kept = mentions.filter((mention) => text.includes(`@${mention.name}`))
  return {
    text,
    body: toDoc(text, kept),
    mentions: kept.map((mention) => mention.id),
    attachments,
  }
}
