/**
 * Разбор XML без внешних зависимостей и без опасных возможностей формата
 * (ADR-0201): ленты CAP и индексы Atom/RSS приходят из чужих систем.
 *
 * - Объявление DOCTYPE пропускается целиком вместе с внутренним подмножеством:
 *   свои сущности документа не определяются и не раскрываются, внешние не
 *   загружаются — нет XXE и «миллиарда смешков».
 * - Раскрываются только пять предопределённых сущностей и числовые ссылки на
 *   символы; неизвестная сущность остаётся текстом как есть.
 * - Имена — локальные, без префикса пространства имён: `cap:alert` и `alert`
 *   одно и то же (CAP публикуют и с префиксом, и без).
 * - Пределы глубины и числа узлов: документ сверх них — ошибка, а не зависание.
 */

export interface XmlElement {
  /** Локальное имя без префикса. */
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
}

export type XmlNode = XmlElement | string

export class XmlError extends Error {}

const MAX_DEPTH = 64
const MAX_NODES = 200_000

const PREDEFINED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Символ, допустимый в XML 1.0: управляющие и суррогаты — нет. */
function allowedCodePoint(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  )
}

/** Предопределённые сущности и ссылки на символы; остальное — как есть. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) && allowedCodePoint(code) ? String.fromCodePoint(code) : whole
    }
    return PREDEFINED[body] ?? whole
  })
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

const NAME = /^[^\s/>=]+/

/**
 * Документ XML → корневой элемент. Текст и CDATA — строками среди детей,
 * пробельные промежутки между элементами отбрасываются.
 */
export function parseXml(input: string): XmlElement {
  const text = input.replace(/^\uFEFF/, '')
  const root: XmlElement = { name: '#document', attributes: {}, children: [] }
  const stack: XmlElement[] = [root]
  let nodes = 0
  let index = 0

  const current = () => stack[stack.length - 1] as XmlElement
  const pushText = (value: string) => {
    if (value.trim() === '') return
    if (++nodes > MAX_NODES) throw new XmlError('Слишком большой документ XML')
    current().children.push(value)
  }

  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open < 0) {
      pushText(decodeEntities(text.slice(index)))
      break
    }
    if (open > index) pushText(decodeEntities(text.slice(index, open)))

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4)
      if (end < 0) throw new XmlError('Комментарий XML не закрыт')
      index = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9)
      if (end < 0) throw new XmlError('Блок CDATA не закрыт')
      pushText(text.slice(open + 9, end))
      index = end + 3
      continue
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2)
      if (end < 0) throw new XmlError('Инструкция обработки XML не закрыта')
      index = end + 2
      continue
    }
    if (text.startsWith('<!', open)) {
      // DOCTYPE и прочие объявления: пропуск с внутренним подмножеством [...]
      let at = open + 2
      let bracket = 0
      while (at < text.length) {
        const char = text[at]
        if (char === '[') bracket += 1
        else if (char === ']') bracket -= 1
        else if (char === '>' && bracket <= 0) break
        at += 1
      }
      if (at >= text.length) throw new XmlError('Объявление XML не закрыто')
      index = at + 1
      continue
    }
    if (text[open + 1] === '/') {
      const end = text.indexOf('>', open + 2)
      if (end < 0) throw new XmlError('Закрывающий тег XML не закрыт')
      const name = localName(text.slice(open + 2, end).trim())
      const element = current()
      if (stack.length <= 1 || element.name !== name) {
        throw new XmlError(`Тег </${name}> не соответствует открытому`)
      }
      stack.pop()
      index = end + 1
      continue
    }

    // Открывающий тег: имя, атрибуты, «/>» или «>»
    let at = open + 1
    const nameMatch = NAME.exec(text.slice(at, at + 256))
    if (!nameMatch) throw new XmlError('Неверный тег XML')
    const element: XmlElement = {
      name: localName(nameMatch[0]),
      attributes: {},
      children: [],
    }
    at += nameMatch[0].length
    let selfClosing = false
    for (;;) {
      while (at < text.length && /\s/.test(text[at] as string)) at += 1
      if (at >= text.length) throw new XmlError('Тег XML не закрыт')
      if (text.startsWith('/>', at)) {
        selfClosing = true
        at += 2
        break
      }
      if (text[at] === '>') {
        at += 1
        break
      }
      const attr = NAME.exec(text.slice(at, at + 256))
      if (!attr) throw new XmlError('Неверный атрибут XML')
      at += attr[0].length
      while (at < text.length && /\s/.test(text[at] as string)) at += 1
      if (text[at] !== '=') throw new XmlError('У атрибута XML нет значения')
      at += 1
      while (at < text.length && /\s/.test(text[at] as string)) at += 1
      const quote = text[at]
      if (quote !== '"' && quote !== "'") throw new XmlError('Значение атрибута XML без кавычек')
      const close = text.indexOf(quote, at + 1)
      if (close < 0) throw new XmlError('Значение атрибута XML не закрыто')
      element.attributes[localName(attr[0])] = decodeEntities(text.slice(at + 1, close))
      at = close + 1
    }
    if (++nodes > MAX_NODES) throw new XmlError('Слишком большой документ XML')
    current().children.push(element)
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new XmlError('Слишком глубокая вложенность XML')
      stack.push(element)
    }
    index = at
  }
  if (stack.length > 1) throw new XmlError(`Тег <${current().name}> не закрыт`)
  const top = root.children.find((child): child is XmlElement => typeof child !== 'string')
  if (!top) throw new XmlError('В документе нет корневого элемента')
  return top
}

/** Дочерние элементы с этим локальным именем. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== 'string' && child.name === name,
  )
}

/** Первый дочерний элемент с этим локальным именем. */
export function childNamed(element: XmlElement, name: string): XmlElement | null {
  return childrenNamed(element, name)[0] ?? null
}

/** Текст элемента со всеми вложенными, без крайних пробелов. */
export function textOf(element: XmlElement | null): string {
  if (!element) return ''
  const parts: string[] = []
  const visit = (node: XmlNode) => {
    if (typeof node === 'string') parts.push(node)
    else for (const child of node.children) visit(child)
  }
  visit(element)
  return parts.join('').trim()
}

/** Текст первого дочернего элемента с этим именем; нет — пустая строка. */
export function childText(element: XmlElement, name: string): string {
  return textOf(childNamed(element, name))
}

/** Потомки на любой глубине с этим локальным именем (в порядке документа). */
export function descendantsNamed(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = []
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue
      if (child.name === name) found.push(child)
      else visit(child)
    }
  }
  visit(element)
  return found
}
