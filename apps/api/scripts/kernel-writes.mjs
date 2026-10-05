#!/usr/bin/env node
/**
 * Запись в таблицы ядра вне ядра (ADR-0184). Таблицы ядра пишут только его сервисы:
 * у них — версии объекта, события outbox, аудит и сброс кэшей, которые прямая запись
 * модуля обходит (так описание датасета не доходило до поиска, ADR-0170). Правило
 * dependency-cruiser `kernel-tables-via-services` пускает модуль только к реестру
 * объектов — на чтение; этот скрипт ловит запись:
 *  - `.insert(t)`, `.update(t)`, `.delete(t)` Drizzle, где `t` — таблица из
 *    `src/kernel/<область>/schema.ts`;
 *  - сырой DML в шаблонах SQL: `INSERT INTO`, `UPDATE`, `DELETE FROM` по таблице ядра —
 *    подстановкой `${t}` или именем таблицы.
 *
 *   node scripts/kernel-writes.mjs     проверка (часть `pnpm deps:check`)
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Осознанные исключения (ADR-0184). identity — модуль входа: он пишет в учётную
 * запись справочника столбцы входа и связи с каталогом (отметка входа, источник
 * входа, DN и время синхронизации LDAP/AD, ADR-0179); остальное о людях — через
 * сервисы справочника ядра.
 */
const ALLOWED = [{ module: 'identity', table: 'users' }]

/** Все `.ts` под каталогом, кроме тестов. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** Таблицы ядра: имя экспорта → имя таблицы в БД. */
function kernelTables() {
  const byExport = new Map()
  const definition = /export const (\w+)\s*=\s*(?:pgTable|\w+\.table)\(\s*'([a-z_0-9]+)'/g
  for (const file of sources(path.join(ROOT, 'src/kernel'))) {
    if (!file.endsWith(`${path.sep}schema.ts`)) continue
    for (const match of readFileSync(file, 'utf8').matchAll(definition)) {
      byExport.set(match[1], match[2])
    }
  }
  return byExport
}

/** Локальные имена таблиц ядра в файле: `import { a, b as c } from '~/kernel/x/schema.js'`. */
function importedKernelTables(text, tables) {
  const local = new Map()
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*kernel\/[^']+\/schema\.js'/g
  for (const match of text.matchAll(imports)) {
    for (const part of match[1].split(',')) {
      const [name, alias] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
      if (name && tables.has(name)) local.set((alias ?? name).trim(), tables.get(name))
    }
  }
  return local
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function check() {
  const tables = kernelTables()
  const sqlNames = new Set(tables.values())
  const violations = []

  for (const file of sources(path.join(ROOT, 'src/modules'))) {
    const name = rel(file)
    const module = /^src\/modules\/([^/]+)\//.exec(name)?.[1]
    const text = readFileSync(file, 'utf8')
    const local = importedKernelTables(text, tables)
    const allowed = (table) =>
      ALLOWED.some((rule) => rule.module === module && rule.table === table)

    const report = (index, table, how) => {
      if (!allowed(table)) violations.push(`${name}:${lineOf(text, index)}  ${how} ${table}`)
    }

    for (const match of text.matchAll(/\.(insert|update|delete)\(\s*(\w+)\s*\)/g)) {
      const table = local.get(match[2])
      if (table) report(match.index, table, `.${match[1]}()`)
    }
    const dml =
      /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:\$\{\s*(\w+)\s*\}|(?:(?:public|ops)\.)?"?([a-z_0-9]+)"?)/g
    for (const match of text.matchAll(dml)) {
      const table = match[2] ? local.get(match[2]) : sqlNames.has(match[3]) ? match[3] : undefined
      if (table) report(match.index, table, match[1].replace(/\s+/g, ' '))
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Запись в таблицы ядра вне ядра (ADR-0184) — через сервисы ядра:\n  ${violations.join('\n  ')}\n`,
    )
    process.exit(1)
  }
  process.stdout.write(
    `✔ запись в таблицы ядра из модулей не найдена (${tables.size} таблиц ядра)\n`,
  )
}

check()
