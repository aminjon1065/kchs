/**
 * Проверка полноты словарей: любой ключ ru должен существовать в tg/en
 * или осознанно отсутствовать (fallback). Отчёт — покрытие по локалям.
 */
import { en } from '../src/locales/en.js'
import { ru } from '../src/locales/ru.js'
import { tg } from '../src/locales/tg.js'
import { LOCALES } from '../src/resources.js'

const dictionaries = { ru, tg, en } as const

function flatten(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.push(path)
    else out.push(...flatten(value, path))
  }
  return out
}

const ruKeys = flatten(dictionaries.ru)
let failed = false

for (const locale of LOCALES) {
  const keys = new Set(flatten(dictionaries[locale]))
  const missing = ruKeys.filter((k) => !keys.has(k))
  const coverage = ((ruKeys.length - missing.length) / ruKeys.length) * 100
  const extra = [...keys].filter((k) => !ruKeys.includes(k))
  process.stdout.write(
    `${locale}: ${coverage.toFixed(1)}% (${ruKeys.length - missing.length}/${ruKeys.length})` +
      (extra.length ? `, лишних ключей: ${extra.length}` : '') +
      '\n',
  )
  if (extra.length) {
    for (const k of extra.slice(0, 20)) process.stdout.write(`  лишний: ${k}\n`)
    failed = true
  }
  if (locale === 'ru' && missing.length) failed = true
}

process.exit(failed ? 1 : 0)
