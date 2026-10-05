import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_DOMAINS, OBJECT_TYPES } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'

/**
 * Ядро не знает модули по именам (ADR-0182): типы объектов и домены событий модулей
 * не встречаются в коде ядра строками — модуль объявляет своё через реестры ядра и
 * признаки типа объекта. Исключения ниже — совпадения слов, а не словарь модулей.
 */
const KERNEL_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Домены событий ядра сверх тех, что публикует его код: уведомления и возможности
 * установки, а также словарь безопасности справочника — пользователи, оргструктура,
 * роли, замещения, сессии и каталог (обязательные действия аудита, 17-security.md §6;
 * справочник — часть ядра, ADR-0178).
 */
const KERNEL_DOMAINS = [
  'notification',
  'feature',
  'user',
  'org',
  'role',
  'delegation',
  'session',
  'directory',
]

interface Allowed {
  file: RegExp
  literal: string
  reason: string
}

const ALLOWED: Allowed[] = [
  { file: /schema\.ts$/, literal: 'source', reason: 'имя столбца' },
  { file: /schema\.ts$/, literal: 'token', reason: 'имя столбца' },
  { file: /schema\.ts$/, literal: 'event', reason: 'имя столбца' },
  { file: /^events\//, literal: 'event', reason: 'поле записи потока шины' },
  { file: /^process\//, literal: 'task', reason: 'вид шага маршрута (@kchs/process)' },
  { file: /^process\//, literal: 'call', reason: 'вид шага маршрута (@kchs/process)' },
  { file: /^process\//, literal: 'event', reason: 'исход ожидания события' },
  {
    file: /^audit\/service\.ts$/,
    literal: 'document.confidential_access',
    reason:
      'ключ журнала аудита доступа к объекту с грифом (ADR-0080): переименование разорвало бы журнал',
  },
]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
  })
}

function kernelTypes(): Set<string> {
  const text = readFileSync(path.join(KERNEL_DIR, 'object-types.ts'), 'utf8')
  return new Set([...text.matchAll(/\btype: '([a-z_]+)'/g)].map((match) => match[1] ?? ''))
}

function kernelPublishedDomains(files: string[]): Set<string> {
  const domains = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\btype: '([a-z_]+)\.[a-z_.]+'/g)) domains.add(match[1] ?? '')
  }
  return domains
}

describe('ядро без словаря модулей', () => {
  it('в коде ядра нет типов объектов и доменов событий модулей строками', () => {
    const files = sources(KERNEL_DIR)
    const kernelOwned = new Set([...kernelPublishedDomains(files), ...KERNEL_DOMAINS])
    const types = kernelTypes()
    const moduleWords = new Set([
      ...OBJECT_TYPES.filter((type) => !types.has(type)),
      ...EVENT_DOMAINS.filter((domain) => !kernelOwned.has(domain)),
    ])
    expect(moduleWords.has('dataset')).toBe(true)
    expect(moduleWords.has('object')).toBe(false)

    const found: string[] = []
    for (const file of files) {
      const relative = path.relative(KERNEL_DIR, file).split(path.sep).join('/')
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/'([a-z_]+)(\.[a-z_.*]+)?'/g)) {
        const [literal, word] = match
        if (!word || !moduleWords.has(word)) continue
        const value = literal.slice(1, -1)
        const allowed = ALLOWED.some((item) => item.file.test(relative) && item.literal === value)
        if (!allowed) found.push(`${relative}: ${literal}`)
      }
    }
    expect(found).toEqual([])
  })
})
