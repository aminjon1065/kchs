#!/usr/bin/env node
/**
 * Сырой SQL — только в слоях, которые для него устроены (ADR-0184, правило 5
 * CLAUDE.md). `sql.raw(…)` Drizzle и `.unsafe(…)` postgres.js вставляют текст в
 * запрос как есть; остальной код строит SQL шаблоном `sql` с параметрами или
 * фрагментами этих слоёв (`tableSql`/`columnSql` модуля данных, `quoteIdent`
 * `@kchs/query`, `readAsQueryRole` для текста компилятора).
 *
 * Проверяются исходники `apps/api/src` и `packages/<пакет>/src`, кроме тестов.
 *
 *   node scripts/raw-sql.mjs     проверка (часть `pnpm deps:check`)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REPO = path.dirname(path.dirname(API))

/** Где сырой SQL допустим и почему. Путь с `/` на конце — каталог целиком. */
const ALLOWED = [
  {
    path: 'apps/api/src/modules/data/infra/',
    why: 'физическое хранение датасетов: DDL схемы `ds`, COPY импорта, имена из `ident`',
  },
  {
    path: 'apps/api/src/shared/db/',
    why: 'миграции, права ролей, секции аудита; чтение текста компилятора под `kchs_query`',
  },
  {
    path: 'packages/query/src/',
    why: 'компилятор QuerySpec и сырого SQL лаборатории',
  },
  {
    path: 'apps/api/src/modules/integrations/infra/database-source.ts',
    why: 'внешняя СУБД источника (ADR-0107): SQL к чужой базе под учётной записью интеграции',
  },
]

const RAW = /\b(\w+)\.raw\s*\(|\.unsafe\s*\(/g

/** Исходники `.ts`/`.tsx` под каталогом, кроме тестов. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(REPO, file).split(path.sep).join('/')
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const allowedFor = (name) =>
  ALLOWED.find((rule) =>
    rule.path.endsWith('/') ? name.startsWith(rule.path) : name === rule.path,
  )

function roots() {
  const packages = path.join(REPO, 'packages')
  return [
    path.join(API, 'src'),
    ...readdirSync(packages)
      .map((name) => path.join(packages, name, 'src'))
      .filter((dir) => existsSync(dir) && statSync(dir).isDirectory()),
  ]
}

function check() {
  const violations = []
  const used = new Set()
  let files = 0
  for (const root of roots()) {
    for (const file of sources(root)) {
      files++
      const name = rel(file)
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(RAW)) {
        // `String.raw` — шаблон строки, не SQL
        if (match[1] === 'String') continue
        const rule = allowedFor(name)
        if (rule) used.add(rule.path)
        else
          violations.push(`${name}:${lineOf(text, match.index)}  ${match[0].replace(/\s+/g, '')}`)
      }
    }
  }
  // Исключение-файл без сырого SQL — устарело: список исключений не растёт молча
  const stale = ALLOWED.filter((rule) => !rule.path.endsWith('/') && !used.has(rule.path))

  if (violations.length > 0 || stale.length > 0) {
    if (violations.length > 0) {
      process.stderr.write(
        `Сырой SQL вне слоёв, где он допустим (ADR-0184) — параметры шаблона \`sql\`, фрагменты infra или readAsQueryRole:\n  ${violations.join('\n  ')}\n`,
      )
    }
    if (stale.length > 0) {
      process.stderr.write(
        `Исключения без сырого SQL — уберите из списка scripts/raw-sql.mjs:\n  ${stale.map((rule) => rule.path).join('\n  ')}\n`,
      )
    }
    process.exit(1)
  }
  process.stdout.write(
    `✔ сырой SQL только в допустимых слоях (${files} файлов, исключений: ${ALLOWED.length})\n`,
  )
}

check()
