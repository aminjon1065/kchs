import {
  RICH_TEXT_ATTRS,
  RICH_TEXT_MARKS,
  RICH_TEXT_NODES,
  type RichBody,
  safeHref,
} from '@kchs/contracts'
import * as Y from 'yjs'

/**
 * Текст Tiptap в документе Yjs — `Y.XmlFragment` в раскладке y-prosemirror
 * (@tiptap/y-tiptap): узел — `Y.XmlElement` с именем типа и атрибутами, текст —
 * `Y.XmlText`, где атрибут форматирования = метка, значение = её атрибуты.
 * Сервер переводит его в JSON и обратно без ProseMirror (снимок для поиска и
 * экспорта, начальное состояние из JSON) — только в пределах белого списка:
 * документ пишут клиенты, и в нём может оказаться что угодно.
 */

type Json = Record<string, unknown>

const NODES = new Set<string>(RICH_TEXT_NODES)
const MARKS = new Set<string>(RICH_TEXT_MARKS)
const NO_ATTRS: readonly string[] = []

/** Разрешённые атрибуты узла или метки; ссылка — только с безопасным адресом. */
function allowedAttrs(type: string, attrs: unknown): Json | null {
  if (typeof attrs !== 'object' || attrs === null) return null
  const out: Json = {}
  for (const key of RICH_TEXT_ATTRS[type] ?? NO_ATTRS) {
    const value = (attrs as Json)[key]
    if (value === null || value === undefined) continue
    if (type === 'link' && key === 'href') {
      const href = safeHref(value)
      if (href) out.href = href
      continue
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

// ─── Y.XmlFragment → JSON ────────────────────────────────────────────────────

export function fragmentToRichBody(fragment: Y.XmlFragment): RichBody {
  return { type: 'doc', content: fragment.toArray().flatMap(nodeToJson) }
}

function nodeToJson(node: Y.XmlElement | Y.XmlText | Y.XmlHook): Json[] {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta() as Array<{ insert?: unknown; attributes?: Json }>
    return delta.flatMap((op) => {
      if (typeof op.insert !== 'string' || op.insert.length === 0) return []
      const text: Json = { type: 'text', text: op.insert }
      const marks = Object.entries(op.attributes ?? {}).flatMap(([name, attrs]) => {
        // Перекрывающиеся метки одного типа y-prosemirror хранит как `тип--хеш`
        const type = name.split('--')[0] ?? name
        if (!MARKS.has(type)) return []
        const allowed = allowedAttrs(type, attrs)
        if (type === 'link' && !allowed) return []
        return [allowed ? { type, attrs: allowed } : { type }]
      })
      if (marks.length > 0) text.marks = marks
      return [text]
    })
  }
  if (node instanceof Y.XmlElement) {
    // Неизвестный узел отбрасывается вместе с содержимым
    if (!NODES.has(node.nodeName)) return []
    const json: Json = { type: node.nodeName }
    const attrs = allowedAttrs(node.nodeName, node.getAttributes())
    if (attrs) json.attrs = attrs
    const content = node.toArray().flatMap(nodeToJson)
    if (content.length > 0) json.content = content
    return [json]
  }
  return []
}

// ─── JSON → Y.XmlFragment ────────────────────────────────────────────────────

/** Содержимое документа Tiptap — в пустой фрагмент (новый или ещё не встроенный в документ). */
export function richBodyToFragment(body: RichBody, fragment: Y.XmlFragment): void {
  const nodes = contentToNodes(body.content)
  if (nodes.length > 0) fragment.insert(0, nodes)
}

function contentToNodes(content: unknown): Array<Y.XmlElement | Y.XmlText> {
  if (!Array.isArray(content)) return []
  const out: Array<Y.XmlElement | Y.XmlText> = []
  // Подряд идущие текстовые узлы — один Y.XmlText, как у y-prosemirror
  let run: Array<{ insert: string; attributes: Json }> = []
  const flush = () => {
    if (run.length === 0) return
    const text = new Y.XmlText()
    text.applyDelta(run)
    out.push(text)
    run = []
  }
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const node = item as Json
    if (node.type === 'text') {
      if (typeof node.text === 'string' && node.text.length > 0) {
        run.push({ insert: node.text, attributes: marksToAttributes(node.marks) })
      }
      continue
    }
    flush()
    const element = elementOf(node)
    if (element) out.push(element)
  }
  flush()
  return out
}

function elementOf(node: Json): Y.XmlElement | null {
  const type = typeof node.type === 'string' ? node.type : ''
  if (!NODES.has(type)) return null
  const element = new Y.XmlElement(type)
  for (const [key, value] of Object.entries(allowedAttrs(type, node.attrs) ?? {})) {
    // Атрибуты y-prosemirror — значения JSON (уровень заголовка — число)
    element.setAttribute(key, value as string)
  }
  const children = contentToNodes(node.content)
  if (children.length > 0) element.insert(0, children)
  return element
}

function marksToAttributes(marks: unknown): Json {
  const attributes: Json = {}
  if (!Array.isArray(marks)) return attributes
  for (const mark of marks) {
    const type = typeof (mark as Json)?.type === 'string' ? ((mark as Json).type as string) : ''
    if (!MARKS.has(type)) continue
    const attrs = allowedAttrs(type, (mark as Json).attrs)
    if (type === 'link' && !attrs) continue
    attributes[type] = attrs ?? {}
  }
  return attributes
}
