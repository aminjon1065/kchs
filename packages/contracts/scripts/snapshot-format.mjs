/**
 * Формат снимков контрактов (ADR-0189): события и OpenAPI хранятся в git в нормализованном
 * виде — только структура схем, без описаний и примеров, с упорядоченными ключами, по
 * строке на запись. Так изменения в истории построчные, а сравнение снимков не зависит
 * от порядка и формулировок.
 */
import { createHash } from 'node:crypto'

/** Не часть контракта: подписи, примеры, значения по умолчанию, служебные ключи. */
const DROP = new Set([
  '$schema',
  '$id',
  'default',
  'deprecated',
  'description',
  'example',
  'examples',
  'summary',
  'tags',
  'title',
])

/** Структура схемы без описаний; ключи упорядочены, `required` и перечисления — тоже. */
export function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeSchema)
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const key of Object.keys(node).sort()) {
    if (DROP.has(key)) continue
    // Формат (uuid, email, date-time) уже говорит, что это за строка; выражение zod — шум
    if (key === 'pattern' && typeof node.format === 'string') continue
    const value = node[key]
    if ((key === 'required' || key === 'enum') && Array.isArray(value)) {
      out[key] = value.every((item) => typeof item !== 'object')
        ? [...value].sort((a, b) => String(a).localeCompare(String(b)))
        : value.map(normalizeSchema)
    } else {
      out[key] = normalizeSchema(value)
    }
  }
  return out
}

/** Объект как JSON — по строке на ключ, ключи по порядку. */
export function writeLines(record) {
  const keys = Object.keys(record).sort()
  if (keys.length === 0) return '{}\n'
  const lines = keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(record[key])}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

/** Повторы крупнее этого (символов JSON) выносятся в общие схемы. */
const MIN_SHARED = 120

const isShareable = (node) =>
  node &&
  typeof node === 'object' &&
  !Array.isArray(node) &&
  (node.type === 'object' || node.anyOf || node.oneOf)

/**
 * Общие схемы: поддерево-объект, которое встречается больше одного раза, хранится один раз
 * под ключом-хэшем содержимого, а на его месте — `{ "$ref": "<ключ>" }`. Полная спецификация
 * OpenAPI (~12 МБ, схемы zod развёрнуты в каждом ответе) так сжимается в несколько раз.
 */
export function shareRepeats(record) {
  const counts = new Map()
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    if (isShareable(node)) {
      const text = JSON.stringify(node)
      if (text.length > MIN_SHARED) counts.set(text, (counts.get(text) ?? 0) + 1)
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(record)

  const defs = {}
  const replace = (node) => {
    if (Array.isArray(node)) return node.map(replace)
    if (!node || typeof node !== 'object') return node
    const text = JSON.stringify(node)
    const inner = () => Object.fromEntries(Object.entries(node).map(([k, v]) => [k, replace(v)]))
    if (isShareable(node) && (counts.get(text) ?? 0) > 1) {
      const id = createHash('sha256').update(text).digest('hex').slice(0, 12)
      if (!(id in defs)) defs[id] = inner()
      return { $ref: id }
    }
    return inner()
  }
  const shared = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, replace(v)]))
  return { records: shared, defs }
}

/** Развернуть ссылку на общую схему (`{ "$ref": id }`). */
export function resolveRef(node, defs) {
  let current = node
  const seen = new Set()
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) break
    seen.add(current.$ref)
    current = defs?.[current.$ref] ?? current
    if (current === node) break
  }
  return current
}
