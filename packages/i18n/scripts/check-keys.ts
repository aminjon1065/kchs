/**
 * Проверка словарей (`pnpm i18n:check`, ADR-0191) по неймспейсам:
 * - покрытие tg и en — 100 % в каждом неймспейсе: в браузере модульный неймспейс грузится
 *   только на языке интерфейса, запасного `ru` рядом с ним нет; лишних ключей нет;
 * - раскладка: файлы `locales/<язык>/<неймспейс>.ts`, индексы языков, `NAMESPACES` и
 *   загрузчики браузера (`loaders.ts`) описывают один и тот же набор неймспейсов;
 * - каждый загрузчик отдаёт свой неймспейс, а `core.ts` языка — ровно неймспейсы оболочки.
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CORE_LOADERS, MODULE_LOADERS } from '../src/loaders.js'
import { en } from '../src/locales/en/index.js'
import { core as ruCore } from '../src/locales/ru/core.js'
import { ru } from '../src/locales/ru/index.js'
import { tg } from '../src/locales/tg/index.js'
import { CORE_NAMESPACES, isCoreNamespace, NAMESPACES } from '../src/namespaces.js'
import { LOCALES, type Locale } from '../src/resources.js'

const dictionaries: Record<Locale, Record<string, unknown>> = { ru, tg, en }
const LOCALES_DIR = fileURLToPath(new URL('../src/locales/', import.meta.url))

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

const problems: string[] = []
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

// Раскладка: файлы, индексы языков и перечень неймспейсов
for (const locale of LOCALES) {
  const files = readdirSync(`${LOCALES_DIR}${locale}`)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && file !== 'core.ts')
    .map((file) => file.slice(0, -3))
  if (!sameSet(files, NAMESPACES))
    problems.push(`${locale}: файлы неймспейсов не совпадают с NAMESPACES (${files.join(', ')})`)
  if (!sameSet(Object.keys(dictionaries[locale]), NAMESPACES))
    problems.push(`${locale}: индекс языка не совпадает с NAMESPACES`)
}

// Загрузчики браузера: модульный неймспейс — свой файл, `core.ts` — ровно оболочка
const coreSets: Record<Locale, Record<string, unknown>> = {
  ru: ruCore,
  tg: await CORE_LOADERS.tg(),
  en: await CORE_LOADERS.en(),
}
for (const locale of LOCALES) {
  const loaders: Record<string, () => Promise<object>> = MODULE_LOADERS[locale]
  const modules = NAMESPACES.filter((namespace) => !isCoreNamespace(namespace))
  if (!sameSet(Object.keys(loaders), modules))
    problems.push(`${locale}: загрузчики модульных неймспейсов не совпадают с перечнем`)
  for (const namespace of modules) {
    const loaded = await loaders[namespace]?.()
    if (loaded !== dictionaries[locale][namespace])
      problems.push(`${locale}: загрузчик «${namespace}» отдаёт не свой неймспейс`)
  }
  const coreSet = coreSets[locale]
  if (!sameSet(Object.keys(coreSet), CORE_NAMESPACES))
    problems.push(`${locale}: core.ts не совпадает с CORE_NAMESPACES`)
  for (const namespace of CORE_NAMESPACES) {
    if (coreSet[namespace] !== dictionaries[locale][namespace])
      problems.push(`${locale}: core.ts отдаёт не тот «${namespace}»`)
  }
}

// Покрытие по неймспейсам
const percent = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`
const totals: Record<Locale, { have: number; all: number }> = {
  ru: { have: 0, all: 0 },
  tg: { have: 0, all: 0 },
  en: { have: 0, all: 0 },
}
const width = Math.max(...NAMESPACES.map((namespace) => namespace.length)) + 2
process.stdout.write(
  `неймспейсов ${NAMESPACES.length}: оболочки ${CORE_NAMESPACES.length}, модульных ` +
    `${NAMESPACES.length - CORE_NAMESPACES.length}\n` +
    `${''.padEnd(width)}${'ключей'.padStart(7)}${LOCALES.filter((locale) => locale !== 'ru')
      .map((locale) => locale.padStart(9))
      .join('')}\n`,
)
for (const namespace of NAMESPACES) {
  const ruKeys = flatten(ru[namespace])
  const cells: string[] = []
  for (const locale of LOCALES) {
    const keys = new Set(flatten(dictionaries[locale][namespace]))
    const missing = ruKeys.filter((key) => !keys.has(key))
    const extra = [...keys].filter((key) => !ruKeys.includes(key))
    totals[locale].have += ruKeys.length - missing.length
    totals[locale].all += ruKeys.length
    if (locale !== 'ru')
      cells.push(percent(ruKeys.length - missing.length, ruKeys.length).padStart(9))
    for (const key of missing.slice(0, 5))
      problems.push(`${locale}: нет перевода ${namespace}.${key}`)
    if (missing.length > 5)
      problems.push(`${locale}: …и ещё ${missing.length - 5} в «${namespace}»`)
    for (const key of extra.slice(0, 5)) problems.push(`${locale}: лишний ключ ${namespace}.${key}`)
  }
  const mark = isCoreNamespace(namespace) ? '*' : ' '
  process.stdout.write(
    `${`${mark}${namespace}`.padEnd(width)}${String(ruKeys.length).padStart(7)}${cells.join('')}\n`,
  )
}
process.stdout.write('* — неймспейс оболочки\n')
for (const locale of LOCALES) {
  const { have, all } = totals[locale]
  process.stdout.write(`${locale}: ${percent(have, all)} (${have}/${all})\n`)
}
for (const problem of problems) process.stdout.write(`  ${problem}\n`)
process.exit(problems.length ? 1 : 0)
